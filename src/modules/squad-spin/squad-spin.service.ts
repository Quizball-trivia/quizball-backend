import { randomUUID } from 'crypto';
import { sql, type TransactionSql } from '../../db/index.js';
import { storeRepo } from '../store/store.repo.js';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { createLiveStats, type LiveStats } from '../synthetic-bots/live-stats.js';
import { squadSpinRepo } from './squad-spin.repo.js';
import { ensureDailyCalibration } from './squad-spin.calibration.js';
import { resolveSquadSpinAnswer } from './squad-spin.resolver.js';
import { comboOffsetFromSeed, commitmentFor, newServerSeed, roundHmacInput } from './squad-spin.fairness.js';
import {
  COMBO_PICK_ATTEMPTS,
  DECISION_MS,
  FAIRNESS_VERSION,
  MAX_SPINS_PER_RUN,
  QUESTION_WINDOW_MS,
  SQUAD_SPIN_MAX_STAKE,
  SQUAD_SPIN_MIN_STAKE,
  SQUAD_SPIN_PAYOUT_EVENT,
  SQUAD_SPIN_REEL_COUNTS,
  SQUAD_SPIN_STAKE_EVENT,
  cashoutValue,
  fairPotAfterSpin,
  payoutIdempotencyKey,
  runPotCap,
  stakeIdempotencyKey,
  type SquadSpinTier,
} from './squad-spin.constants.js';
import type { SquadSpinComboRow, SquadSpinPlayerRow, SquadSpinPosition, SquadSpinRoundRow, StepsSnapshot } from './squad-spin.types.js';

export interface ReelView {
  family: 'club' | 'country' | 'league' | 'manager' | 'trophy_award' | 'position';
  id: string;
  key: string;
  label_en: string;
  label_ka: string;
  asset_key: string | null;
}
export interface PlayerView { id: string; name_en: string; name_ka: string | null; image_url: string | null }

/** Public round state — never contains the seed or the answer set while active. */
export interface SquadSpinPublicState {
  round_id: string;
  status: string;
  phase: string;
  state_version: number;
  stake_coins: number;
  reels: number;
  /** Cash-out value now (margin applied); the stake until the first correct answer. */
  pot_coins: number;
  mult_bp: number;
  spins_cleared: number;
  max_spins: number;
  /** Cash-out value the run cannot exceed (auto-banks when reached). */
  run_cap_coins: number;
  steps_bp: StepsSnapshot;
  spin: { index: number; tier: SquadSpinTier; step_bp: number; next_pot_coins: number; reels: ReelView[]; dealt_at: string; deadline_at: string } | null;
  decision_deadline_at: string | null;
  payout_coins: number | null;
  commit_hash: string;
  fairness_version: number;
  /** Settled only. On a loss `answers` names ONE valid player, never the full set (it would make the pool harvestable). */
  reveal: { answers: PlayerView[]; server_seed: string; hmac_input: string } | null;
  server_now: string;
}

export interface SquadSpinAnswerResult {
  outcome: 'correct' | 'wrong' | 'late';
  player: PlayerView | null;
  answers: PlayerView[];
  state: SquadSpinPublicState;
}

const POSITION_LABELS: Record<SquadSpinPosition, { en: string; ka: string }> = {
  GK: { en: 'Goalkeeper', ka: 'მეკარე' },
  DEF: { en: 'Defender', ka: 'მცველი' },
  MID: { en: 'Midfielder', ka: 'ნახევარმცველი' },
  FWD: { en: 'Forward', ka: 'თავდამსხმელი' },
};

const stepsOf = (row: SquadSpinRoundRow) => row.steps_bp as unknown as StepsSnapshot;
const questionExpired = (row: SquadSpinRoundRow) => row.phase === 'question' && row.question_deadline_at != null && new Date(row.question_deadline_at).getTime() <= Date.now();
const decisionExpired = (row: SquadSpinRoundRow) => row.phase === 'decision' && row.decision_deadline_at != null && new Date(row.decision_deadline_at).getTime() <= Date.now();
const toPlayerView = (p: SquadSpinPlayerRow): PlayerView => ({ id: p.id, name_en: p.name_en, name_ka: p.name_ka, image_url: p.image_url });

async function reelsFor(combo: SquadSpinComboRow, tx?: TransactionSql): Promise<ReelView[]> {
  const criteria = await squadSpinRepo.getCriteriaByIds([combo.club_id, combo.nation_id, ...combo.extra_ids], tx);
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const view = (id: string): ReelView => {
    const c = byId.get(id);
    if (!c) throw new AppError('Squad Spin combo references unknown criterion', 500);
    return { family: c.family, id: c.id, key: c.criterion_key, label_en: c.label_en, label_ka: c.label_ka, asset_key: c.asset_key };
  };
  const position: ReelView = { family: 'position', id: combo.position_group, key: combo.position_group, label_en: POSITION_LABELS[combo.position_group].en, label_ka: POSITION_LABELS[combo.position_group].ka, asset_key: null };
  return [view(combo.club_id), position, view(combo.nation_id), ...combo.extra_ids.map(view)];
}

async function toPublicState(row: SquadSpinRoundRow, opts: { combo?: SquadSpinComboRow | null; answers?: PlayerView[]; tx?: TransactionSql } = {}): Promise<SquadSpinPublicState> {
  const steps = stepsOf(row);
  const potNow = row.status === 'active' ? (row.spins_cleared > 0 ? cashoutValue(row.pot_coins, steps.margin) : row.stake_coins) : row.pot_coins;
  let spin: SquadSpinPublicState['spin'] = null;
  if (row.status === 'active' && row.phase === 'question' && row.combo_id && row.question_deadline_at && row.question_dealt_at) {
    const combo = opts.combo ?? (await squadSpinRepo.getComboById(row.combo_id, opts.tx));
    if (!combo) throw new AppError('Squad Spin combo missing', 500);
    const stepBp = steps[combo.tier];
    spin = {
      index: row.spins_cleared + 1,
      tier: combo.tier,
      step_bp: stepBp,
      next_pot_coins: cashoutValue(fairPotAfterSpin(row.pot_coins, stepBp, row.stake_coins), steps.margin),
      reels: await reelsFor(combo, opts.tx),
      dealt_at: row.question_dealt_at,
      deadline_at: row.question_deadline_at,
    };
  }
  return {
    round_id: row.id,
    status: row.status,
    phase: row.phase,
    state_version: row.state_version,
    stake_coins: row.stake_coins,
    reels: row.reels,
    pot_coins: potNow,
    mult_bp: Math.round((potNow * 10_000) / row.stake_coins),
    spins_cleared: row.spins_cleared,
    max_spins: MAX_SPINS_PER_RUN,
    run_cap_coins: cashoutValue(runPotCap(row.stake_coins), steps.margin),
    steps_bp: steps,
    spin,
    decision_deadline_at: row.phase === 'decision' ? row.decision_deadline_at : null,
    payout_coins: row.payout_coins,
    commit_hash: row.commit_hash,
    fairness_version: FAIRNESS_VERSION,
    reveal: row.status === 'active' ? null : { answers: opts.answers ?? [], server_seed: row.server_seed, hmac_input: roundHmacInput(row.id, row.client_nonce) },
    server_now: new Date().toISOString(),
  };
}

/**
 * Deterministic combo for spin n: HMAC offset into the list of combos this player
 * has NOT been dealt within the seen window (so a revealed answer cannot be
 * cashed in on a later run), skipping repeats inside the run. Only when a player
 * has exhausted the pool does the pick fall back to the full active list.
 */
async function pickCombo(tx: TransactionSql, input: { roundId: string; userId: string; clientNonce: string | null; serverSeed: string; reels: number; spinIndex: number; seen: string[] }): Promise<SquadSpinComboRow> {
  const hmacInput = roundHmacInput(input.roundId, input.clientNonce);
  const eligible = await squadSpinRepo.countEligibleCombos(tx, input.userId, input.reels);
  const count = eligible > 0 ? eligible : await squadSpinRepo.countActiveCombos(tx, input.reels);
  if (count === 0) throw new AppError('No Squad Spin content for this reel count', 503);
  let fallback: SquadSpinComboRow | null = null;
  for (let attempt = 0; attempt < COMBO_PICK_ATTEMPTS; attempt += 1) {
    const offset = comboOffsetFromSeed(input.serverSeed, hmacInput, input.spinIndex, attempt, count);
    const combo = eligible > 0
      ? await squadSpinRepo.getEligibleComboAtOffset(tx, input.userId, input.reels, offset)
      : await squadSpinRepo.getComboAtOffset(tx, input.reels, offset);
    if (!combo) continue;
    if (!input.seen.includes(combo.id)) { await squadSpinRepo.markComboSeen(tx, input.userId, combo.id); return combo; }
    fallback ??= combo;
  }
  if (!fallback) throw new AppError('Squad Spin content unavailable', 503);
  await squadSpinRepo.markComboSeen(tx, input.userId, fallback.id);
  return fallback;
}

async function answersOf(combo: SquadSpinComboRow, tx?: TransactionSql): Promise<PlayerView[]> {
  return (await squadSpinRepo.getPlayersByIds(combo.answer_ids, tx)).map(toPlayerView);
}

/** What a loss shows: the single best-known valid player (players are ordered by peak value). */
async function oneAnswerOf(combo: SquadSpinComboRow, tx?: TransactionSql): Promise<PlayerView[]> {
  return (await answersOf(combo, tx)).slice(0, 1);
}

/** The single payout primitive; the ledger unique index makes it once-only even if two paths race. */
async function settleCashout(tx: TransactionSql, row: SquadSpinRoundRow, eventType: 'cashout' | 'auto_cashout'): Promise<SquadSpinRoundRow> {
  const payout = cashoutValue(row.pot_coins, stepsOf(row).margin);
  const updated = await squadSpinRepo.updateRoundState(tx, row.id, row.state_version, {
    status: 'cashed', phase: 'settled', pot_coins: payout, payout_coins: payout, settled_at: new Date().toISOString(), decision_deadline_at: null, question_deadline_at: null,
  });
  if (!updated) throw new ConflictError('Round already settled');
  try {
    await storeRepo.insertTransactionLogInTx(tx, {
      eventType: SQUAD_SPIN_PAYOUT_EVENT, outcome: 'success', userId: row.user_id, coinsDelta: payout,
      reason: eventType === 'cashout' ? 'squad_spin_cashout' : 'squad_spin_auto_cashout', idempotencyKey: payoutIdempotencyKey(row.id),
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      logger.error({ roundId: row.id }, 'squad-spin payout idempotency collision');
      throw new ConflictError('Round already settled');
    }
    throw error;
  }
  const wallet = await storeRepo.adjustWalletInTx(tx, row.user_id, payout, 0);
  if (!wallet) throw new AppError('Wallet credit failed', 500);
  await squadSpinRepo.insertEvent(tx, { roundId: updated.id, userId: updated.user_id, stateVersion: updated.state_version, eventType, potBefore: payout, potAfter: payout, serverSeed: row.server_seed, hmacInput: roundHmacInput(row.id, row.client_nonce) });
  return updated;
}

async function settleLost(tx: TransactionSql, row: SquadSpinRoundRow): Promise<SquadSpinRoundRow> {
  const updated = await squadSpinRepo.updateRoundState(tx, row.id, row.state_version, {
    status: 'lost', phase: 'settled', pot_coins: 0, settled_at: new Date().toISOString(), question_deadline_at: null, decision_deadline_at: null,
  });
  if (!updated) throw new ConflictError('Round state changed');
  return updated;
}

/** A spin left unanswered past its deadline is a miss; a decision left open banks the pot. */
async function resolveExpired(tx: TransactionSql, row: SquadSpinRoundRow): Promise<SquadSpinRoundRow> {
  if (questionExpired(row)) {
    const combo = row.combo_id ? await squadSpinRepo.getComboById(row.combo_id, tx) : null;
    const lost = await settleLost(tx, row);
    await squadSpinRepo.insertEvent(tx, {
      roundId: lost.id, userId: lost.user_id, stateVersion: lost.state_version, eventType: 'answer', spinIndex: row.spins_cleared + 1, comboId: row.combo_id,
      tier: combo?.tier ?? null, answerCorrect: false, answerLate: true, potBefore: row.pot_coins, potAfter: 0, serverSeed: row.server_seed, hmacInput: roundHmacInput(row.id, row.client_nonce),
    });
    return lost;
  }
  if (decisionExpired(row)) return settleCashout(tx, row, 'auto_cashout');
  return row;
}

async function dealNextSpin(tx: TransactionSql, row: SquadSpinRoundRow): Promise<{ row: SquadSpinRoundRow; combo: SquadSpinComboRow }> {
  const combo = await pickCombo(tx, { roundId: row.id, userId: row.user_id, clientNonce: row.client_nonce, serverSeed: row.server_seed, reels: row.reels, spinIndex: row.spins_cleared + 1, seen: row.combo_ids });
  const now = new Date();
  const updated = await squadSpinRepo.updateRoundState(tx, row.id, row.state_version, {
    phase: 'question', combo_id: combo.id, combo_ids: [...row.combo_ids, combo.id], question_dealt_at: now.toISOString(),
    question_deadline_at: new Date(now.getTime() + QUESTION_WINDOW_MS).toISOString(), decision_deadline_at: null,
  });
  if (!updated) throw new ConflictError('Round state changed');
  await squadSpinRepo.insertEvent(tx, { roundId: updated.id, userId: updated.user_id, stateVersion: updated.state_version, eventType: 'spin_dealt', spinIndex: updated.spins_cleared + 1, comboId: combo.id, tier: combo.tier });
  return { row: updated, combo };
}

function assertVersion(row: SquadSpinRoundRow, expectedVersion: number): void {
  if (row.state_version !== expectedVersion) throw new ConflictError('Stale state — refresh the round');
}

function assertRound(row: SquadSpinRoundRow, roundId: string): void {
  if (row.id !== roundId) throw new ConflictError('Request targets a different round');
}

/** Terminal rounds carry the single revealed answer of the combo they died on. */
async function settledState(row: SquadSpinRoundRow, tx?: TransactionSql): Promise<SquadSpinPublicState> {
  if (row.status === 'lost' && row.combo_id) {
    const combo = await squadSpinRepo.getComboById(row.combo_id, tx);
    return toPublicState(row, { answers: combo ? await oneAnswerOf(combo, tx) : [], tx });
  }
  return toPublicState(row, { tx });
}

export type SquadSpinStats = LiveStats & { top_runs: Array<{ nickname: string; run_mult: number }> };
const loadLiveStats = createLiveStats({
  countPlayingNow: () => squadSpinRepo.countPlayingNow(),
  getRecentWins: (n) => squadSpinRepo.getRecentWins(n),
  extras: async () => ({ top_runs: (await squadSpinRepo.getTopRuns(5)).map((run) => ({ nickname: run.nickname, run_mult: Math.round(run.run_mult * 100) / 100 })) }),
});

export const squadSpinService = {
  async startRound(userId: string, input: { stakeCoins: number; reels: number; clientNonce: string | null }): Promise<SquadSpinPublicState> {
    if (!Number.isInteger(input.stakeCoins) || input.stakeCoins < SQUAD_SPIN_MIN_STAKE || input.stakeCoins > SQUAD_SPIN_MAX_STAKE) {
      throw new BadRequestError(`Stake must be an integer between ${SQUAD_SPIN_MIN_STAKE} and ${SQUAD_SPIN_MAX_STAKE}`);
    }
    if (!(SQUAD_SPIN_REEL_COUNTS as readonly number[]).includes(input.reels)) throw new BadRequestError('Reels must be 3, 4 or 5');
    const run = () => sql.begin(async (tx) => {
      // A retried start (lost response) replays its round instead of debiting a second stake.
      if (input.clientNonce) {
        const replay = await squadSpinRepo.getRoundByNonceForUpdate(tx, userId, input.clientNonce);
        if (replay) return replay.status === 'active' ? toPublicState(await resolveExpired(tx, replay), { tx }) : settledState(replay, tx);
      }
      const existing = await squadSpinRepo.getActiveRoundForUpdate(tx, userId);
      if (existing) {
        const resolved = await resolveExpired(tx, existing);
        if (resolved.status === 'active') throw new ConflictError('An active round already exists');
      }
      const calibration = await ensureDailyCalibration(tx);
      const wallet = await storeRepo.adjustWalletInTx(tx, userId, -input.stakeCoins, 0);
      if (!wallet) throw new BadRequestError('Not enough coins');
      const roundId = randomUUID();
      const serverSeed = newServerSeed();
      const combo = await pickCombo(tx, { roundId, userId, clientNonce: input.clientNonce, serverSeed, reels: input.reels, spinIndex: 1, seen: [] });
      // One clock for the deal: the row's dealt_at and the deadline must not straddle the lock/calibration waits.
      const dealtAt = new Date();
      const round = await squadSpinRepo.insertRound(tx, {
        roundId, userId, stakeCoins: input.stakeCoins, reels: input.reels, comboId: combo.id,
        questionDealtAt: dealtAt.toISOString(), questionDeadlineAt: new Date(dealtAt.getTime() + QUESTION_WINDOW_MS).toISOString(),
        stepsBp: calibration.steps_bp, calibrationDay: calibration.publication_day, serverSeed, commitHash: commitmentFor(serverSeed), clientNonce: input.clientNonce,
      });
      await storeRepo.insertTransactionLogInTx(tx, {
        eventType: SQUAD_SPIN_STAKE_EVENT, outcome: 'success', userId, coinsDelta: -input.stakeCoins, reason: 'squad_spin_stake', idempotencyKey: stakeIdempotencyKey(round.id),
      });
      await squadSpinRepo.insertEvent(tx, { roundId: round.id, userId, stateVersion: round.state_version, eventType: 'start', commitHash: round.commit_hash, clientNonce: input.clientNonce, potBefore: input.stakeCoins, potAfter: input.stakeCoins });
      await squadSpinRepo.insertEvent(tx, { roundId: round.id, userId, stateVersion: round.state_version, eventType: 'spin_dealt', spinIndex: 1, comboId: combo.id, tier: combo.tier });
      return toPublicState(round, { combo, tx });
    });
    try {
      return await run();
    } catch (error) {
      // Two starts raced on the same nonce or the active-round index: the second one replays.
      if ((error as { code?: string }).code === '23505' && input.clientNonce) return run();
      throw error;
    }
  },

  /** Expiry is resolved here too, so a client that only polls never sees a dead deadline. */
  async getCurrentState(userId: string): Promise<SquadSpinPublicState> {
    return sql.begin(async (tx) => {
      const row = await squadSpinRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      const resolved = await resolveExpired(tx, row);
      return resolved.status === 'active' ? toPublicState(resolved, { tx }) : settledState(resolved, tx);
    });
  },

  /** Most recent round in any state; lets a client recover a run the sweeper settled while it was away. */
  async getLatestState(userId: string): Promise<SquadSpinPublicState> {
    const row = await squadSpinRepo.getLatestRound(userId);
    if (!row) throw new NotFoundError('No rounds yet');
    if (row.status === 'active') return this.getCurrentState(userId);
    return settledState(row);
  },

  async answer(userId: string, input: { roundId: string; text: string; expectedVersion: number }): Promise<SquadSpinAnswerResult> {
    return sql.begin(async (tx) => {
      const row = await squadSpinRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      assertRound(row, input.roundId);
      if (row.phase !== 'question' || !row.combo_id) throw new ConflictError('No spin is pending');
      assertVersion(row, input.expectedVersion);
      const combo = await squadSpinRepo.getComboById(row.combo_id, tx);
      if (!combo) throw new AppError('Squad Spin combo missing', 500);
      const answerMs = row.question_dealt_at ? Date.now() - new Date(row.question_dealt_at).getTime() : null;
      const late = questionExpired(row);
      const resolved = late ? { playerId: null, normalizedInput: '' } : resolveSquadSpinAnswer(input.text, await squadSpinRepo.getAliasesForPlayers(combo.answer_ids, tx));
      const correct = resolved.playerId != null;
      const potBefore = row.pot_coins;
      const hmacInput = roundHmacInput(row.id, row.client_nonce);

      if (!correct) {
        const answers = await oneAnswerOf(combo, tx);
        const lost = await settleLost(tx, row);
        await squadSpinRepo.insertEvent(tx, {
          roundId: lost.id, userId, stateVersion: lost.state_version, eventType: 'answer', spinIndex: row.spins_cleared + 1, comboId: combo.id, tier: combo.tier,
          submittedText: input.text.slice(0, 160), answerCorrect: false, answerLate: late, answerMs, potBefore, potAfter: 0, serverSeed: row.server_seed, hmacInput,
        });
        return { outcome: late ? 'late' : 'wrong', player: null, answers, state: await toPublicState(lost, { answers, tx }) };
      }

      const player = (await answersOf(combo, tx)).find((a) => a.id === resolved.playerId) ?? null;
      const potAfter = fairPotAfterSpin(row.pot_coins, stepsOf(row)[combo.tier], row.stake_coins);
      const updated = await squadSpinRepo.updateRoundState(tx, row.id, row.state_version, {
        phase: 'decision', pot_coins: potAfter, spins_cleared: row.spins_cleared + 1, question_deadline_at: null,
        decision_deadline_at: new Date(Date.now() + DECISION_MS).toISOString(),
      });
      if (!updated) throw new ConflictError('Round state changed');
      await squadSpinRepo.insertEvent(tx, {
        roundId: updated.id, userId, stateVersion: updated.state_version, eventType: 'answer', spinIndex: row.spins_cleared + 1, comboId: combo.id, tier: combo.tier,
        submittedText: input.text.slice(0, 160), resolvedPlayerId: resolved.playerId, answerCorrect: true, answerLate: false, answerMs, potBefore, potAfter,
      });
      // Nothing left to win past the run cap or the spin limit: bank it automatically.
      if (potAfter >= runPotCap(row.stake_coins) || updated.spins_cleared >= MAX_SPINS_PER_RUN) {
        const banked = await settleCashout(tx, updated, 'auto_cashout');
        return { outcome: 'correct', player, answers: [], state: await toPublicState(banked, { tx }) };
      }
      return { outcome: 'correct', player, answers: [], state: await toPublicState(updated, { tx }) };
    });
  },

  /** Spin again: the decision is taken before the next combo is revealed. */
  async continueRound(userId: string, input: { roundId: string; expectedVersion: number }): Promise<SquadSpinPublicState> {
    return sql.begin(async (tx) => {
      const row = await squadSpinRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      assertRound(row, input.roundId);
      if (row.phase !== 'decision') throw new ConflictError('Round cannot continue now');
      assertVersion(row, input.expectedVersion);
      if (decisionExpired(row)) return toPublicState(await settleCashout(tx, row, 'auto_cashout'), { tx });
      const dealt = await dealNextSpin(tx, row);
      await squadSpinRepo.insertEvent(tx, { roundId: dealt.row.id, userId, stateVersion: dealt.row.state_version, eventType: 'continue', spinIndex: dealt.row.spins_cleared + 1, potBefore: row.pot_coins, potAfter: row.pot_coins });
      return toPublicState(dealt.row, { combo: dealt.combo, tx });
    });
  },

  async cashout(userId: string, input: { roundId: string; expectedVersion: number }): Promise<SquadSpinPublicState> {
    return sql.begin(async (tx) => {
      const row = await squadSpinRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      assertRound(row, input.roundId);
      if (row.phase !== 'decision' || row.spins_cleared === 0) throw new ConflictError('Answer a spin correctly before cashing out');
      assertVersion(row, input.expectedVersion);
      return toPublicState(await settleCashout(tx, row, decisionExpired(row) ? 'auto_cashout' : 'cashout'), { tx });
    });
  },

  getStats: (): Promise<SquadSpinStats> => loadLiveStats(),

  async heartbeat(userId: string): Promise<void> {
    await squadSpinRepo.touchLastSeen(userId);
  },

  async sweepExpiredRounds(): Promise<{ settled: number }> {
    const ids = await squadSpinRepo.getExpiredActiveRoundIds(50);
    let settled = 0;
    for (const id of ids) {
      try {
        await sql.begin(async (tx) => {
          const row = await squadSpinRepo.getRoundForUpdateSkipLocked(tx, id);
          if (!row || row.status !== 'active') return;
          const resolved = await resolveExpired(tx, row);
          if (resolved.status !== 'active') settled += 1;
        });
      } catch (error) {
        logger.error({ roundId: id, error }, 'squad-spin sweep failed for round');
      }
    }
    return { settled };
  },
};
