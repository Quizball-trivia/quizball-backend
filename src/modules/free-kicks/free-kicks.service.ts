import { sql, type TransactionSql } from '../../db/index.js';
import { storeRepo } from '../store/store.repo.js';
import { freeKicksRepo } from './free-kicks.repo.js';
import {
  FREE_KICKS_MAX_STAKE,
  FREE_KICKS_MIN_STAKE,
  FREE_KICKS_PAYOUT_EVENT,
  FREE_KICKS_STAKE_EVENT,
  MAX_OPEN,
  MIN_OPEN,
  QUESTION_WINDOW_MS,
  STALE_AFTER_MS,
  ZONE_ORDER_VERSION,
  applyMultiplier,
  openZones,
  payoutIdempotencyKey,
  stakeIdempotencyKey,
  type FreeKicksZone,
} from './free-kicks.constants.js';
import {
  commitmentFor,
  keeperHmacInput,
  keeperZoneFromSeed,
  newServerSeed,
} from './free-kicks.fairness.js';
import type { DealtQuestionSnapshot, FreeKicksRoundRow } from './free-kicks.types.js';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { I18nField, Json } from '../../db/types.js';

interface McqOptionShape {
  id: string;
  text: I18nField;
  is_correct: boolean;
}

/** Public round state — never contains seeds or the correct option. */
export interface FreeKicksPublicState {
  round_id: string;
  status: string;
  phase: string;
  state_version: number;
  stake_coins: number;
  pot_coins: number;
  attack: number;
  open_count: number;
  open_zones: readonly FreeKicksZone[];
  answer_locked: boolean;
  goals: number;
  commit_hash: string;
  zone_order_version: number;
  question: {
    question_id: string;
    prompt: I18nField;
    options: Array<{ id: string; text: I18nField }>;
    deadline_at: string;
  } | null;
  payout_coins: number | null;
  server_now: string;
}

function toPublicState(row: FreeKicksRoundRow): FreeKicksPublicState {
  const snapshot = row.question_payload as unknown as DealtQuestionSnapshot | null;
  return {
    round_id: row.id,
    status: row.status,
    phase: row.phase,
    state_version: row.state_version,
    stake_coins: row.stake_coins,
    pot_coins: row.pot_coins,
    attack: row.attack,
    open_count: row.open_count,
    open_zones: openZones(row.open_count),
    answer_locked: row.answer_locked,
    goals: row.goals,
    commit_hash: row.commit_hash,
    zone_order_version: ZONE_ORDER_VERSION,
    question:
      snapshot && row.question_id && row.question_deadline_at
        ? {
            question_id: row.question_id,
            prompt: snapshot.prompt,
            options: snapshot.options,
            deadline_at: row.question_deadline_at,
          }
        : null,
    payout_coins: row.payout_coins,
    server_now: new Date().toISOString(),
  };
}

function questionExpired(row: FreeKicksRoundRow): boolean {
  return (
    row.phase === 'question'
    && row.question_deadline_at != null
    && new Date(row.question_deadline_at).getTime() <= Date.now()
  );
}

function isStale(row: FreeKicksRoundRow): boolean {
  return new Date(row.last_seen_at).getTime() <= Date.now() - STALE_AFTER_MS;
}

/** Fisher–Yates over option order so the stored snapshot is the shown order. */
function shuffleOptions<T>(options: T[]): T[] {
  const out = [...options];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function parseMcqOptions(payload: unknown): McqOptionShape[] | null {
  const parsed = typeof payload === 'string' ? safeJson(payload) : payload;
  const options = (parsed as { options?: unknown })?.options;
  if (!Array.isArray(options) || options.length !== 4) return null;
  const shaped: McqOptionShape[] = [];
  for (const option of options) {
    const candidate = option as Partial<McqOptionShape>;
    if (
      typeof candidate.id !== 'string'
      || candidate.text == null
      || typeof candidate.is_correct !== 'boolean'
    ) {
      return null;
    }
    shaped.push(candidate as McqOptionShape);
  }
  if (shaped.filter((option) => option.is_correct).length !== 1) return null;
  return shaped;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Resolve an expired pending question in-place (wrong-answer consequences:
 * zones slam to 2, answering locks for the attack). Returns the updated row.
 */
async function resolveExpiredQuestion(
  tx: TransactionSql,
  row: FreeKicksRoundRow
): Promise<FreeKicksRoundRow> {
  if (!questionExpired(row)) return row;
  const updated = await freeKicksRepo.updateRoundState(tx, row.id, row.state_version, {
    phase: 'deciding',
    open_count: MIN_OPEN,
    answer_locked: true,
    question_id: null,
    question_payload: null,
    question_correct_option: null,
    question_deadline_at: null,
  });
  if (!updated) throw new ConflictError('Round state changed');
  await freeKicksRepo.insertEvent(tx, {
    roundId: updated.id,
    userId: updated.user_id,
    attack: updated.attack,
    stateVersion: updated.state_version,
    eventType: 'question_expired',
    questionId: row.question_id,
    openCount: updated.open_count,
  });
  return updated;
}

/**
 * The single settlement primitive: every path that pays a pot (manual cashout,
 * disconnect auto-cashout, inline recovery) goes through here, inside the
 * caller's row-locked transaction. The ledger unique index makes the payout
 * once-only even if two paths race.
 */
async function settleCashout(
  tx: TransactionSql,
  row: FreeKicksRoundRow,
  eventType: 'cashout' | 'auto_cashout'
): Promise<FreeKicksRoundRow> {
  const payout = row.pot_coins;
  const updated = await freeKicksRepo.updateRoundState(tx, row.id, row.state_version, {
    status: 'cashed',
    phase: 'settled',
    payout_coins: payout,
    settled_at: new Date().toISOString(),
    question_id: null,
    question_payload: null,
    question_correct_option: null,
    question_deadline_at: null,
  });
  if (!updated) throw new ConflictError('Round already settled');

  try {
    await storeRepo.insertTransactionLogInTx(tx, {
      eventType: FREE_KICKS_PAYOUT_EVENT,
      outcome: 'success',
      userId: row.user_id,
      coinsDelta: payout,
      reason: eventType === 'cashout' ? 'free_kicks_cashout' : 'free_kicks_auto_cashout',
      idempotencyKey: payoutIdempotencyKey(row.id),
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      // Another settlement path already paid this round — abort loudly; the
      // transaction rolls back our status change too.
      logger.error({ roundId: row.id }, 'free-kicks payout idempotency collision');
      throw new ConflictError('Round already settled');
    }
    throw error;
  }

  const wallet = await storeRepo.adjustWalletInTx(tx, row.user_id, payout, 0);
  if (!wallet) throw new AppError('Wallet credit failed', 500);

  await freeKicksRepo.insertEvent(tx, {
    roundId: updated.id,
    userId: updated.user_id,
    attack: updated.attack,
    stateVersion: updated.state_version,
    eventType,
    potBefore: payout,
    potAfter: payout,
  });
  return updated;
}

async function expireRound(tx: TransactionSql, row: FreeKicksRoundRow): Promise<void> {
  const updated = await freeKicksRepo.updateRoundState(tx, row.id, row.state_version, {
    status: 'expired',
    phase: 'settled',
    pot_coins: 0,
    settled_at: new Date().toISOString(),
    question_id: null,
    question_payload: null,
    question_correct_option: null,
    question_deadline_at: null,
  });
  if (!updated) throw new ConflictError('Round state changed');
  await freeKicksRepo.insertEvent(tx, {
    roundId: updated.id,
    userId: updated.user_id,
    attack: updated.attack,
    stateVersion: updated.state_version,
    eventType: 'expired',
    potBefore: row.pot_coins,
    potAfter: 0,
  });
}

/** Settle a stale round per policy: banked (post-goal) pots are cashed out;
 *  anything else was abandoned mid-attack and expires. */
async function settleStale(tx: TransactionSql, row: FreeKicksRoundRow): Promise<void> {
  const current = await resolveExpiredQuestion(tx, row);
  if (current.phase === 'post_goal') {
    await settleCashout(tx, current, 'auto_cashout');
  } else {
    await expireRound(tx, current);
  }
}

function assertVersion(row: FreeKicksRoundRow, expectedVersion: number): void {
  if (row.state_version !== expectedVersion) {
    throw new ConflictError('Stale state — refresh the round');
  }
}


let statsCache: { at: number; value: FreeKicksStats } | null = null;
const STATS_CACHE_MS = 10_000;

export interface FreeKicksStats {
  playing_now: number;
  recent_wins: Array<{ nickname: string; amount: number; run_mult: number; settled_at: string }>;
  top_runs: Array<{ nickname: string; run_mult: number }>;
}

export const freeKicksService = {
  async startRound(
    userId: string,
    stakeCoins: number,
    clientNonce: string | null
  ): Promise<FreeKicksPublicState> {
    if (
      !Number.isInteger(stakeCoins)
      || stakeCoins < FREE_KICKS_MIN_STAKE
      || stakeCoins > FREE_KICKS_MAX_STAKE
    ) {
      throw new BadRequestError(
        `Stake must be an integer between ${FREE_KICKS_MIN_STAKE} and ${FREE_KICKS_MAX_STAKE}`
      );
    }

    return sql.begin(async (tx) => {
      const existing = await freeKicksRepo.getActiveRoundForUpdate(tx, userId);
      if (existing) {
        if (isStale(existing)) {
          await settleStale(tx, existing);
        } else {
          throw new ConflictError('An active round already exists');
        }
      }

      const wallet = await storeRepo.adjustWalletInTx(tx, userId, -stakeCoins, 0);
      if (!wallet) throw new BadRequestError('Not enough coins');

      const serverSeed = newServerSeed();
      const round = await freeKicksRepo.insertRound(tx, {
        userId,
        stakeCoins,
        serverSeed,
        commitHash: commitmentFor(serverSeed),
        clientNonce,
      });

      await storeRepo.insertTransactionLogInTx(tx, {
        eventType: FREE_KICKS_STAKE_EVENT,
        outcome: 'success',
        userId,
        coinsDelta: -stakeCoins,
        reason: 'free_kicks_stake',
        idempotencyKey: stakeIdempotencyKey(round.id),
      });

      await freeKicksRepo.insertEvent(tx, {
        roundId: round.id,
        userId,
        attack: 0,
        stateVersion: round.state_version,
        eventType: 'start',
        openCount: round.open_count,
        commitHash: round.commit_hash,
        clientNonce,
        potBefore: stakeCoins,
        potAfter: stakeCoins,
      });

      return toPublicState(round);
    });
  },

  async getCurrentState(userId: string): Promise<FreeKicksPublicState> {
    const row = await freeKicksRepo.getActiveRound(userId);
    if (!row) throw new NotFoundError('No active round');
    return toPublicState(row);
  },

  async dealQuestion(userId: string, expectedVersion: number): Promise<FreeKicksPublicState> {
    return sql.begin(async (tx) => {
      let row = await freeKicksRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      const beforeResolve = row.state_version;
      row = await resolveExpiredQuestion(tx, row);
      if (row.state_version !== beforeResolve) {
        // The pending question just expired — surface the reset state first.
        throw new ConflictError('Question expired — refresh the round');
      }
      assertVersion(row, expectedVersion);
      if (row.phase !== 'deciding') throw new ConflictError('Cannot deal a question now');
      if (row.answer_locked) throw new ConflictError('Answering is locked this attack');
      if (row.open_count >= MAX_OPEN) throw new ConflictError('All zones already open');

      const recent = await freeKicksRepo.getRecentQuestionIds(userId);
      const candidates = await freeKicksRepo.pickQuestionCandidates(recent);
      let picked: { id: string; prompt: I18nField; options: McqOptionShape[] } | null = null;
      for (const candidate of candidates) {
        const options = parseMcqOptions(candidate.payload);
        if (!options) continue;
        const prompt =
          typeof candidate.prompt === 'string'
            ? (safeJson(candidate.prompt) as I18nField | null)
            : (candidate.prompt as unknown as I18nField);
        if (!prompt) continue;
        picked = { id: candidate.id, prompt, options };
        break;
      }
      if (!picked) throw new AppError('No eligible questions available', 503);

      const shuffled = shuffleOptions(picked.options);
      const correct = shuffled.find((option) => option.is_correct);
      if (!correct) throw new AppError('Question integrity error', 500);
      const snapshot: DealtQuestionSnapshot = {
        question_id: picked.id,
        prompt: picked.prompt,
        options: shuffled.map((option) => ({ id: option.id, text: option.text })),
        dealt_at: new Date().toISOString(),
      };

      const updated = await freeKicksRepo.updateRoundState(tx, row.id, row.state_version, {
        phase: 'question',
        question_id: picked.id,
        question_payload: JSON.stringify(snapshot) as unknown as Json,
        question_correct_option: correct.id,
        question_deadline_at: new Date(Date.now() + QUESTION_WINDOW_MS).toISOString(),
      });
      if (!updated) throw new ConflictError('Round state changed');

      await freeKicksRepo.insertEvent(tx, {
        roundId: updated.id,
        userId,
        attack: updated.attack,
        stateVersion: updated.state_version,
        eventType: 'question_dealt',
        questionId: picked.id,
        openCount: updated.open_count,
      });

      return toPublicState(updated);
    });
  },

  async answerQuestion(
    userId: string,
    input: { questionId: string; optionId: string; expectedVersion: number }
  ): Promise<{
    outcome: 'correct' | 'wrong' | 'late';
    correct_option_id: string;
    state: FreeKicksPublicState;
  }> {
    return sql.begin(async (tx) => {
      const row = await freeKicksRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      if (row.phase !== 'question' || row.question_id == null) {
        throw new ConflictError('No question pending');
      }
      if (row.question_id !== input.questionId) {
        throw new ConflictError('Answer targets a stale question');
      }
      assertVersion(row, input.expectedVersion);

      const correctOption = row.question_correct_option as string;
      const dealtAt = (row.question_payload as unknown as DealtQuestionSnapshot | null)?.dealt_at;
      const answerMs = dealtAt ? Date.now() - new Date(dealtAt).getTime() : null;
      const late = questionExpired(row);
      const correct = !late && input.optionId === correctOption;

      const patch = correct
        ? { phase: 'deciding', open_count: Math.min(MAX_OPEN, row.open_count + 1) }
        : { phase: 'deciding', open_count: MIN_OPEN, answer_locked: true };
      const updated = await freeKicksRepo.updateRoundState(tx, row.id, row.state_version, {
        ...patch,
        question_id: null,
        question_payload: null,
        question_correct_option: null,
        question_deadline_at: null,
      });
      if (!updated) throw new ConflictError('Round state changed');

      await freeKicksRepo.insertEvent(tx, {
        roundId: updated.id,
        userId,
        attack: updated.attack,
        stateVersion: updated.state_version,
        eventType: late ? 'question_expired' : 'answer',
        questionId: input.questionId,
        answerOption: input.optionId,
        answerCorrect: late ? false : correct,
        answerMs,
        openCount: updated.open_count,
      });

      return {
        outcome: late ? 'late' : correct ? 'correct' : 'wrong',
        correct_option_id: correctOption,
        state: toPublicState(updated),
      };
    });
  },

  async shoot(
    userId: string,
    input: { zone: string; expectedVersion: number }
  ): Promise<{
    scored: boolean;
    keeper_zone: string;
    proof: {
      server_seed: string;
      commit_hash: string;
      hmac_input: string;
      open_count: number;
      zone_order_version: number;
    };
    state: FreeKicksPublicState;
  }> {
    return sql.begin(async (tx) => {
      let row = await freeKicksRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      if (row.phase === 'question') {
        if (questionExpired(row)) {
          row = await resolveExpiredQuestion(tx, row);
          // Zones just reset — the client must see the new state before shooting.
          throw new ConflictError('Question expired — refresh the round');
        }
        throw new ConflictError('Answer the pending question first');
      }
      assertVersion(row, input.expectedVersion);
      if (row.phase !== 'deciding') throw new ConflictError('Cannot shoot now');

      const zones = openZones(row.open_count);
      if (!zones.includes(input.zone as FreeKicksZone)) {
        throw new BadRequestError('Zone is not open');
      }

      const hmacInput = keeperHmacInput(row.id, row.attack, row.open_count, row.client_nonce);
      const keeper = keeperZoneFromSeed(row.server_seed, hmacInput, row.open_count);
      const scored = input.zone !== keeper.zone;
      const potBefore = row.pot_coins;

      let updated: FreeKicksRoundRow | null;
      if (scored) {
        updated = await freeKicksRepo.updateRoundState(tx, row.id, row.state_version, {
          pot_coins: applyMultiplier(potBefore, row.open_count),
          goals: row.goals + 1,
          phase: 'post_goal',
        });
      } else {
        updated = await freeKicksRepo.updateRoundState(tx, row.id, row.state_version, {
          status: 'lost',
          phase: 'settled',
          pot_coins: 0,
          settled_at: new Date().toISOString(),
        });
      }
      if (!updated) throw new ConflictError('Round state changed');

      await freeKicksRepo.insertEvent(tx, {
        roundId: updated.id,
        userId,
        attack: updated.attack,
        stateVersion: updated.state_version,
        eventType: 'shot',
        openCount: row.open_count,
        pickedZone: input.zone,
        keeperZone: keeper.zone,
        scored,
        commitHash: row.commit_hash,
        serverSeed: row.server_seed,
        clientNonce: row.client_nonce,
        hmacInput,
        potBefore,
        potAfter: updated.pot_coins,
      });

      return {
        scored,
        keeper_zone: keeper.zone,
        proof: {
          server_seed: row.server_seed,
          commit_hash: row.commit_hash,
          hmac_input: hmacInput,
          open_count: row.open_count,
          zone_order_version: ZONE_ORDER_VERSION,
        },
        state: toPublicState(updated),
      };
    });
  },

  async nextAttack(
    userId: string,
    input: { expectedVersion: number; clientNonce: string | null }
  ): Promise<FreeKicksPublicState> {
    return sql.begin(async (tx) => {
      const row = await freeKicksRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      assertVersion(row, input.expectedVersion);
      if (row.phase !== 'post_goal') throw new ConflictError('No goal to build on');

      const serverSeed = newServerSeed();
      const updated = await freeKicksRepo.updateRoundState(tx, row.id, row.state_version, {
        attack: row.attack + 1,
        open_count: MIN_OPEN,
        answer_locked: false,
        phase: 'deciding',
        server_seed: serverSeed,
        commit_hash: commitmentFor(serverSeed),
        client_nonce: input.clientNonce,
      });
      if (!updated) throw new ConflictError('Round state changed');

      await freeKicksRepo.insertEvent(tx, {
        roundId: updated.id,
        userId,
        attack: updated.attack,
        stateVersion: updated.state_version,
        eventType: 'next_attack',
        commitHash: updated.commit_hash,
        clientNonce: input.clientNonce,
        potBefore: row.pot_coins,
        potAfter: row.pot_coins,
      });

      return toPublicState(updated);
    });
  },

  async cashout(userId: string, expectedVersion: number): Promise<FreeKicksPublicState> {
    return sql.begin(async (tx) => {
      const row = await freeKicksRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active round');
      assertVersion(row, expectedVersion);
      if (row.phase !== 'post_goal') throw new ConflictError('Nothing to cash out');
      const updated = await settleCashout(tx, row, 'cashout');
      return toPublicState(updated);
    });
  },

  /** Real social-layer numbers (10s cache): live players, recent wins, top runs. */
  async getStats(): Promise<FreeKicksStats> {
    if (statsCache && Date.now() - statsCache.at < STATS_CACHE_MS) return statsCache.value;
    const [playingNow, recentWins, topRuns] = await Promise.all([
      freeKicksRepo.countPlayingNow(),
      freeKicksRepo.getRecentWins(6),
      freeKicksRepo.getTopRuns(5),
    ]);
    const value: FreeKicksStats = {
      playing_now: playingNow,
      recent_wins: recentWins.map((win) => ({
        nickname: win.nickname,
        amount: win.payout_coins,
        run_mult: Math.round((win.payout_coins / win.stake_coins) * 100) / 100,
        settled_at: win.settled_at,
      })),
      top_runs: topRuns.map((run) => ({
        nickname: run.nickname,
        run_mult: Math.round(run.run_mult * 100) / 100,
      })),
    };
    statsCache = { at: Date.now(), value };
    return value;
  },

  async heartbeat(userId: string): Promise<void> {
    await freeKicksRepo.touchLastSeen(userId);
  },

  /**
   * Auto-settle rounds whose owner went quiet: banked (post-goal) pots pay
   * out; abandoned mid-attack rounds expire. Runs on an interval and inline
   * from startRound. SKIP LOCKED means we never fight a live player action.
   */
  async sweepStaleRounds(): Promise<{ settled: number }> {
    const ids = await freeKicksRepo.getStaleActiveRoundIds(50);
    let settled = 0;
    for (const id of ids) {
      try {
        await sql.begin(async (tx) => {
          const row = await freeKicksRepo.getRoundForUpdateSkipLocked(tx, id);
          if (!row || row.status !== 'active' || !isStale(row)) return;
          await settleStale(tx, row);
          settled += 1;
        });
      } catch (error) {
        logger.error({ roundId: id, error }, 'free-kicks sweep failed for round');
      }
    }
    return { settled };
  },
};
