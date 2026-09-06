import { sql, type TransactionSql } from '../../db/index.js';
import { storeRepo } from '../store/store.repo.js';
import { triviaMinesRepo } from './trivia-mines.repo.js';
import {
  BOARD_SIZE,
  DEFENDERS,
  FAIRNESS_VERSION,
  MAX_SAFE_PICKS,
  QUESTION_WINDOW_MS,
  SCOUTS_PER_ROUND,
  STALE_AFTER_MS,
  TRIVIA_MINES_MAX_STAKE,
  TRIVIA_MINES_MIN_STAKE,
  TRIVIA_MINES_PAYOUT_EVENT,
  TRIVIA_MINES_REFUND_EVENT,
  TRIVIA_MINES_STAKE_EVENT,
  cashoutValue,
  fairPotAfterPick,
  payoutIdempotencyKey,
  refundIdempotencyKey,
  stakeIdempotencyKey,
} from './trivia-mines.constants.js';
import { boardHmacInput, commitmentFor, defendersFromSeed, newServerSeed, scoutRevealFromSeed } from './trivia-mines.fairness.js';
import type { DealtQuestionSnapshot, TriviaMinesRoundRow } from './trivia-mines.types.js';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { createLiveStats, type LiveStats } from '../synthetic-bots/live-stats.js';
import type { I18nField } from '../../db/types.js';

interface McqOptionShape { id: string; text: I18nField; is_correct: boolean }

/** Public round state — never contains the seed, the defenders or the correct option while active. */
export interface TriviaMinesPublicState {
  round_id: string;
  status: string;
  phase: string;
  state_version: number;
  stake_coins: number;
  pot_coins: number;
  /** Pot if the next pick is safe. */
  next_pot_coins: number;
  mult_bp: number;
  opened: number[];
  flagged: number[];
  bust_tile: number | null;
  scouts_left: number;
  board_size: number;
  defender_count: number;
  commit_hash: string;
  fairness_version: number;
  question: { question_id: string; prompt: I18nField; options: Array<{ id: string; text: I18nField }>; deadline_at: string } | null;
  payout_coins: number | null;
  /** Revealed once the round is settled: every defender plus the seed to verify the commitment. */
  reveal: { defenders: number[]; server_seed: string; hmac_input: string } | null;
  server_now: string;
}

function defendersOf(row: TriviaMinesRoundRow): number[] {
  return defendersFromSeed(row.server_seed, boardHmacInput(row.id, row.client_nonce));
}

function toPublicState(row: TriviaMinesRoundRow): TriviaMinesPublicState {
  const snapshot = row.question_payload as unknown as DealtQuestionSnapshot | null;
  const safePicks = row.opened.length;
  const unknown = BOARD_SIZE - row.opened.length - row.flagged.length;
  const hidden = DEFENDERS - row.flagged.length;
  // pot_coins in the row is the FAIR pot; players see the cash-out value (margin applied).
  const potNow = row.status === 'active' ? (safePicks > 0 ? cashoutValue(row.pot_coins) : row.stake_coins) : row.pot_coins;
  const potNext = row.status === 'active' && safePicks < MAX_SAFE_PICKS ? cashoutValue(fairPotAfterPick(row.pot_coins, unknown, hidden)) : potNow;
  return {
    round_id: row.id,
    status: row.status,
    phase: row.phase,
    state_version: row.state_version,
    stake_coins: row.stake_coins,
    pot_coins: potNow,
    next_pot_coins: potNext,
    mult_bp: Math.round((potNow * 10_000) / row.stake_coins),
    opened: row.opened,
    flagged: row.flagged,
    bust_tile: row.bust_tile,
    scouts_left: row.scouts_left,
    board_size: BOARD_SIZE,
    defender_count: DEFENDERS,
    commit_hash: row.commit_hash,
    fairness_version: FAIRNESS_VERSION,
    question: snapshot && row.question_id && row.question_deadline_at
      ? { question_id: row.question_id, prompt: snapshot.prompt, options: snapshot.options, deadline_at: row.question_deadline_at }
      : null,
    payout_coins: row.payout_coins,
    reveal: row.status === 'active' ? null : { defenders: defendersOf(row), server_seed: row.server_seed, hmac_input: boardHmacInput(row.id, row.client_nonce) },
    server_now: new Date().toISOString(),
  };
}

const questionExpired = (row: TriviaMinesRoundRow) =>
  row.phase === 'question' && row.question_deadline_at != null && new Date(row.question_deadline_at).getTime() <= Date.now();
const isStale = (row: TriviaMinesRoundRow) => new Date(row.last_seen_at).getTime() <= Date.now() - STALE_AFTER_MS;
const clearQuestion = { question_id: null, question_payload: null, question_correct_option: null, question_deadline_at: null };

function shuffleOptions<T>(options: T[]): T[] {
  const out = [...options];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function parseMcqOptions(payload: unknown): McqOptionShape[] | null {
  const parsed = typeof payload === 'string' ? safeJson(payload) : payload;
  const options = (parsed as { options?: unknown })?.options;
  if (!Array.isArray(options) || options.length !== 4) return null;
  const shaped: McqOptionShape[] = [];
  for (const option of options) {
    const candidate = option as Partial<McqOptionShape>;
    if (typeof candidate.id !== 'string' || candidate.text == null || typeof candidate.is_correct !== 'boolean') return null;
    shaped.push(candidate as McqOptionShape);
  }
  return shaped.filter((o) => o.is_correct).length === 1 ? shaped : null;
}

/** An expired scout question simply burns the scout; the board is untouched. */
async function resolveExpiredQuestion(tx: TransactionSql, row: TriviaMinesRoundRow): Promise<TriviaMinesRoundRow> {
  if (!questionExpired(row)) return row;
  const updated = await triviaMinesRepo.updateRoundState(tx, row.id, row.state_version, { phase: 'picking', ...clearQuestion });
  if (!updated) throw new ConflictError('Round state changed');
  await triviaMinesRepo.insertEvent(tx, { roundId: updated.id, userId: updated.user_id, stateVersion: updated.state_version, eventType: 'question_expired', questionId: row.question_id });
  return updated;
}

/** The single payout primitive; the ledger unique index makes it once-only even if two paths race. */
async function settleCashout(tx: TransactionSql, row: TriviaMinesRoundRow, eventType: 'cashout' | 'auto_cashout'): Promise<TriviaMinesRoundRow> {
  const payout = cashoutValue(row.pot_coins);
  const updated = await triviaMinesRepo.updateRoundState(tx, row.id, row.state_version, {
    status: 'cashed', phase: 'settled', pot_coins: payout, payout_coins: payout, settled_at: new Date().toISOString(), ...clearQuestion,
  });
  if (!updated) throw new ConflictError('Round already settled');
  try {
    await storeRepo.insertTransactionLogInTx(tx, {
      eventType: TRIVIA_MINES_PAYOUT_EVENT, outcome: 'success', userId: row.user_id, coinsDelta: payout,
      reason: eventType === 'cashout' ? 'trivia_mines_cashout' : 'trivia_mines_auto_cashout', idempotencyKey: payoutIdempotencyKey(row.id),
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      logger.error({ roundId: row.id }, 'trivia-mines payout idempotency collision');
      throw new ConflictError('Round already settled');
    }
    throw error;
  }
  const wallet = await storeRepo.adjustWalletInTx(tx, row.user_id, payout, 0);
  if (!wallet) throw new AppError('Wallet credit failed', 500);
  await triviaMinesRepo.insertEvent(tx, { roundId: updated.id, userId: updated.user_id, stateVersion: updated.state_version, eventType, potBefore: payout, potAfter: payout, serverSeed: row.server_seed, hmacInput: boardHmacInput(row.id, row.client_nonce) });
  return updated;
}

/** Abandoned before any pick: the stake goes back (nothing was risked yet). */
async function expireWithRefund(tx: TransactionSql, row: TriviaMinesRoundRow): Promise<void> {
  const updated = await triviaMinesRepo.updateRoundState(tx, row.id, row.state_version, {
    status: 'expired', phase: 'settled', pot_coins: 0, settled_at: new Date().toISOString(), ...clearQuestion,
  });
  if (!updated) throw new ConflictError('Round state changed');
  try {
    await storeRepo.insertTransactionLogInTx(tx, {
      eventType: TRIVIA_MINES_REFUND_EVENT, outcome: 'success', userId: row.user_id, coinsDelta: row.stake_coins,
      reason: 'trivia_mines_abandoned_refund', idempotencyKey: refundIdempotencyKey(row.id),
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new ConflictError('Round already settled');
    throw error;
  }
  const wallet = await storeRepo.adjustWalletInTx(tx, row.user_id, row.stake_coins, 0);
  if (!wallet) throw new AppError('Wallet refund failed', 500);
  await triviaMinesRepo.insertEvent(tx, { roundId: updated.id, userId: updated.user_id, stateVersion: updated.state_version, eventType: 'refunded', potBefore: row.pot_coins, potAfter: 0 });
}

/** Stale policy: a pot with at least one safe pick is banked; an untouched board refunds the stake. */
async function settleStale(tx: TransactionSql, row: TriviaMinesRoundRow): Promise<void> {
  const current = await resolveExpiredQuestion(tx, row);
  if (current.opened.length > 0) await settleCashout(tx, current, 'auto_cashout');
  else await expireWithRefund(tx, current);
}

function assertVersion(row: TriviaMinesRoundRow, expectedVersion: number): void {
  if (row.state_version !== expectedVersion) throw new ConflictError('Stale state — refresh the round');
}

export type TriviaMinesStats = LiveStats & { top_runs: Array<{ nickname: string; run_mult: number }> };
const loadLiveStats = createLiveStats({
  countPlayingNow: () => triviaMinesRepo.countPlayingNow(),
  getRecentWins: (n) => triviaMinesRepo.getRecentWins(n),
  extras: async () => ({ top_runs: (await triviaMinesRepo.getTopRuns(5)).map((run) => ({ nickname: run.nickname, run_mult: Math.round(run.run_mult * 100) / 100 })) }),
});

export const triviaMinesService = {
  async startRound(userId: string, stakeCoins: number, clientNonce: string | null): Promise<TriviaMinesPublicState> {
    if (!Number.isInteger(stakeCoins) || stakeCoins < TRIVIA_MINES_MIN_STAKE || stakeCoins > TRIVIA_MINES_MAX_STAKE) {
      throw new BadRequestError(`Stake must be an integer between ${TRIVIA_MINES_MIN_STAKE} and ${TRIVIA_MINES_MAX_STAKE}`);
    }
    return sql.begin(async (tx) => {
      const existing = await triviaMinesRepo.getActiveRoundForUpdate(tx, userId);
      if (existing) {
        if (isStale(existing)) await settleStale(tx, existing);
        else throw new ConflictError('An active round already exists');
      }
      const wallet = await storeRepo.adjustWalletInTx(tx, userId, -stakeCoins, 0);
      if (!wallet) throw new BadRequestError('Not enough coins');
      const serverSeed = newServerSeed();
      const round = await triviaMinesRepo.insertRound(tx, { userId, stakeCoins, serverSeed, commitHash: commitmentFor(serverSeed), clientNonce });
      await storeRepo.insertTransactionLogInTx(tx, {
        eventType: TRIVIA_MINES_STAKE_EVENT, outcome: 'success', userId, coinsDelta: -stakeCoins, reason: 'trivia_mines_stake', idempotencyKey: stakeIdempotencyKey(round.id),
      });
      await triviaMinesRepo.insertEvent(tx, { roundId: round.id, userId, stateVersion: round.state_version, eventType: 'start', commitHash: round.commit_hash, clientNonce, potBefore: stakeCoins, potAfter: stakeCoins });
      return toPublicState(round);
    });
  },

  async getCurrentState(userId: string): Promise<TriviaMinesPublicState> {
    const row = await triviaMinesRepo.getActiveRound(userId);
    if (!row) throw new NotFoundError('No active round');
    return toPublicState(row);
  },

  async pick(userId: string, input: { tile: number; expectedVersion: number }): Promise<{ safe: boolean; state: TriviaMinesPublicState }> {
    return sql.begin(async (tx) => {
      let row = await triviaMinesRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      if (row.phase === 'question') {
        if (questionExpired(row)) { row = await resolveExpiredQuestion(tx, row); throw new ConflictError('Question expired — refresh the round'); }
        throw new ConflictError('Answer the pending question first');
      }
      assertVersion(row, input.expectedVersion);
      if (!Number.isInteger(input.tile) || input.tile < 0 || input.tile >= BOARD_SIZE) throw new BadRequestError('Tile out of range');
      if (row.opened.includes(input.tile) || row.flagged.includes(input.tile)) throw new BadRequestError('Tile already resolved');

      const defenders = defendersOf(row);
      const potBefore = row.pot_coins;
      if (defenders.includes(input.tile)) {
        const updated = await triviaMinesRepo.updateRoundState(tx, row.id, row.state_version, {
          status: 'lost', phase: 'settled', pot_coins: 0, bust_tile: input.tile, settled_at: new Date().toISOString(),
        });
        if (!updated) throw new ConflictError('Round state changed');
        await triviaMinesRepo.insertEvent(tx, { roundId: updated.id, userId, stateVersion: updated.state_version, eventType: 'bust', tile: input.tile, commitHash: row.commit_hash, serverSeed: row.server_seed, clientNonce: row.client_nonce, hmacInput: boardHmacInput(row.id, row.client_nonce), potBefore, potAfter: 0 });
        return { safe: false, state: toPublicState(updated) };
      }
      const opened = [...row.opened, input.tile];
      const unknown = BOARD_SIZE - row.opened.length - row.flagged.length;
      const hidden = DEFENDERS - row.flagged.length;
      const updated = await triviaMinesRepo.updateRoundState(tx, row.id, row.state_version, { opened, pot_coins: fairPotAfterPick(row.pot_coins, unknown, hidden) });
      if (!updated) throw new ConflictError('Round state changed');
      await triviaMinesRepo.insertEvent(tx, { roundId: updated.id, userId, stateVersion: updated.state_version, eventType: 'pick', tile: input.tile, potBefore, potAfter: updated.pot_coins });
      // Every safe tile opened: nothing left to risk, bank it automatically.
      if (opened.length >= MAX_SAFE_PICKS) {
        const banked = await settleCashout(tx, updated, 'auto_cashout');
        return { safe: true, state: toPublicState(banked) };
      }
      return { safe: true, state: toPublicState(updated) };
    });
  },

  async dealQuestion(userId: string, expectedVersion: number): Promise<TriviaMinesPublicState> {
    return sql.begin(async (tx) => {
      let row = await triviaMinesRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      const before = row.state_version;
      row = await resolveExpiredQuestion(tx, row);
      if (row.state_version !== before) throw new ConflictError('Question expired — refresh the round');
      assertVersion(row, expectedVersion);
      if (row.phase !== 'picking') throw new ConflictError('Cannot scout now');
      if (row.scouts_left <= 0) throw new ConflictError('No scouts left');
      if (row.flagged.length >= DEFENDERS) throw new ConflictError('Every defender is already flagged');

      const recent = await triviaMinesRepo.getRecentQuestionIds(userId);
      const candidates = await triviaMinesRepo.pickQuestionCandidates(recent);
      let picked: { id: string; prompt: I18nField; options: McqOptionShape[] } | null = null;
      for (const candidate of candidates) {
        const options = parseMcqOptions(candidate.payload);
        if (!options) continue;
        const prompt = typeof candidate.prompt === 'string' ? (safeJson(candidate.prompt) as I18nField | null) : (candidate.prompt as unknown as I18nField);
        if (!prompt) continue;
        picked = { id: candidate.id, prompt, options };
        break;
      }
      if (!picked) throw new AppError('No eligible questions available', 503);
      const shuffled = shuffleOptions(picked.options);
      const correct = shuffled.find((option) => option.is_correct);
      if (!correct) throw new AppError('Question integrity error', 500);
      const snapshot: DealtQuestionSnapshot = { question_id: picked.id, prompt: picked.prompt, options: shuffled.map((o) => ({ id: o.id, text: o.text })), dealt_at: new Date().toISOString() };
      const updated = await triviaMinesRepo.setQuestionSnapshot(tx, row.id, row.state_version, {
        questionId: picked.id, snapshot, correctOption: correct.id, deadlineAt: new Date(Date.now() + QUESTION_WINDOW_MS).toISOString(),
      });
      if (!updated) throw new ConflictError('Round state changed');
      await triviaMinesRepo.insertEvent(tx, { roundId: updated.id, userId, stateVersion: updated.state_version, eventType: 'question_dealt', questionId: picked.id });
      return toPublicState(updated);
    });
  },

  async answerQuestion(userId: string, input: { questionId: string; optionId: string; expectedVersion: number }): Promise<{ outcome: 'correct' | 'wrong' | 'late'; correct_option_id: string; flagged_tile: number | null; state: TriviaMinesPublicState }> {
    return sql.begin(async (tx) => {
      const row = await triviaMinesRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      if (row.phase !== 'question' || row.question_id == null) throw new ConflictError('No question pending');
      if (row.question_id !== input.questionId) throw new ConflictError('Answer targets a stale question');
      assertVersion(row, input.expectedVersion);

      const correctOption = row.question_correct_option as string;
      const dealtAt = (row.question_payload as unknown as DealtQuestionSnapshot | null)?.dealt_at;
      const answerMs = dealtAt ? Date.now() - new Date(dealtAt).getTime() : null;
      const late = questionExpired(row);
      const correct = !late && input.optionId === correctOption;
      const scoutNumber = SCOUTS_PER_ROUND - row.scouts_left;
      let flaggedTile: number | null = null;
      if (correct) {
        const hidden = defendersOf(row).filter((tile) => !row.flagged.includes(tile));
        if (hidden.length) flaggedTile = scoutRevealFromSeed(row.server_seed, boardHmacInput(row.id, row.client_nonce), scoutNumber, hidden);
      }
      const updated = await triviaMinesRepo.updateRoundState(tx, row.id, row.state_version, {
        phase: 'picking', scouts_left: row.scouts_left - 1, flagged: flaggedTile == null ? row.flagged : [...row.flagged, flaggedTile], ...clearQuestion,
      });
      if (!updated) throw new ConflictError('Round state changed');
      await triviaMinesRepo.insertEvent(tx, { roundId: updated.id, userId, stateVersion: updated.state_version, eventType: late ? 'question_expired' : 'answer', questionId: input.questionId, answerOption: input.optionId, answerCorrect: late ? false : correct, answerMs, flaggedTile });
      return { outcome: late ? 'late' : correct ? 'correct' : 'wrong', correct_option_id: correctOption, flagged_tile: flaggedTile, state: toPublicState(updated) };
    });
  },

  async cashout(userId: string, expectedVersion: number): Promise<TriviaMinesPublicState> {
    return sql.begin(async (tx) => {
      const row = await triviaMinesRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      assertVersion(row, expectedVersion);
      if (row.phase !== 'picking') throw new ConflictError('Answer the pending question first');
      if (row.opened.length === 0) throw new ConflictError('Open at least one tile before cashing out');
      return toPublicState(await settleCashout(tx, row, 'cashout'));
    });
  },

  getStats: (): Promise<TriviaMinesStats> => loadLiveStats(),

  async heartbeat(userId: string): Promise<void> {
    await triviaMinesRepo.touchLastSeen(userId);
  },

  async sweepStaleRounds(): Promise<{ settled: number }> {
    const ids = await triviaMinesRepo.getStaleActiveRoundIds(50);
    let settled = 0;
    for (const id of ids) {
      try {
        await sql.begin(async (tx) => {
          const row = await triviaMinesRepo.getRoundForUpdateSkipLocked(tx, id);
          if (!row || row.status !== 'active' || !isStale(row)) return;
          await settleStale(tx, row);
          settled += 1;
        });
      } catch (error) {
        logger.error({ roundId: id, error }, 'trivia-mines sweep failed for round');
      }
    }
    return { settled };
  },
};
