import { createHash } from 'node:crypto';
import { sql, type TransactionSql } from '../../db/index.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import { storeRepo } from '../store/store.repo.js';
import { progressionRepo } from '../progression/progression.repo.js';
import { guessTheGoalRepo } from './guess-the-goal.repo.js';
import { buildTimings, pointsForReveal, revealedMovesAt } from './guess-the-goal.timing.js';
import {
  GGT_BONUS_POINTS,
  GGT_COINS_PER_POINT,
  GGT_DAILY_COIN_CAP,
  GGT_GRACE_MS,
  GGT_MAX_POINTS,
  GGT_MIN_POINTS,
  GGT_REWARD_EVENT,
  GGT_SESSION_STALE_MS,
  GGT_XP_PER_POINT,
  GGT_XP_SOURCE,
} from './guess-the-goal.constants.js';
import type {
  ChoreographyOption,
  GoalChoreographyRow,
  GoalSnapshot,
  GgtSessionRow,
  I18nText,
} from './guess-the-goal.types.js';

interface PublicOption {
  id: string;
  text: I18nText;
}

interface PublicSession {
  session_id: string;
  state: 'active' | 'guessed';
  /** Server wall clock, so the client renders decay from OUR clock. */
  server_now: string;
  started_at: string;
  grace_ms: number;
  max_points: number;
  min_points: number;
  goal: {
    difficulty: string;
    players: GoalSnapshot['players'];
    steps: GoalSnapshot['steps'];
    options: PublicOption[];
    main_moves: number;
    duration_seconds: number;
  };
  /** Present when state = 'guessed' (correct guess, bonus pending). */
  bonus?: { question: I18nText; options: PublicOption[] };
  progress: { solved: number; total: number };
}

interface AwardSummary {
  first_solve: boolean;
  coins: number;
  xp: number;
  daily_cap_reached: boolean;
  /** Authoritative balances after settlement, for client reconciliation. */
  wallet_coins: number | null;
  total_xp: number | null;
}

interface GuessOutcome {
  correct: boolean;
  correct_option_id: string;
  points: number;
  revealed_moves: number;
  title: I18nText;
  fun_fact: I18nText | null;
  bonus?: { question: I18nText; options: PublicOption[] };
  awards: AwardSummary;
  session_state: 'guessed' | 'complete';
}

interface BonusOutcome {
  correct: boolean;
  correct_option_id: string;
  bonus_points: number;
  awards: AwardSummary;
}

const NO_AWARDS: AwardSummary = {
  first_solve: false,
  coins: 0,
  xp: 0,
  daily_cap_reached: false,
  wallet_coins: null,
  total_xp: null,
};

/**
 * Build the immutable per-session snapshot with ANONYMIZED player ids: content
 * rows use meaningful ids ('maradona') that would leak the answer straight
 * through the diagram payload.
 */
function buildSnapshot(goal: GoalChoreographyRow): GoalSnapshot {
  const idMap = new Map<string, string>();
  goal.players.forEach((p, i) => idMap.set(p.id, `p${i + 1}`));
  return {
    difficulty: goal.difficulty,
    title: goal.title,
    fun_fact: goal.fun_fact,
    players: goal.players.map((p) => ({ ...p, id: idMap.get(p.id)! })),
    steps: goal.steps.map((s) => ({ ...s, player: idMap.get(s.player) ?? s.player })),
    options: goal.options,
    bonus: goal.bonus,
  };
}

/** Stable per-session option order so retries and resumes always agree. */
function shuffledOptions(seed: string, options: ChoreographyOption[]): ChoreographyOption[] {
  return [...options].sort((a, b) => {
    const ha = createHash('sha1').update(`${seed}:${a.id}`).digest('hex');
    const hb = createHash('sha1').update(`${seed}:${b.id}`).digest('hex');
    return ha.localeCompare(hb);
  });
}

function sanitizeOptions(seed: string, options: ChoreographyOption[]): PublicOption[] {
  return shuffledOptions(seed, options).map((o) => ({ id: o.id, text: o.text }));
}

function bonusPayload(session: GgtSessionRow): { question: I18nText; options: PublicOption[] } | undefined {
  const bonus = session.goal_snapshot.bonus;
  if (!bonus) return undefined;
  return {
    question: bonus.question,
    options: sanitizeOptions(`${session.id}:bonus`, bonus.options),
  };
}

function elapsedSeconds(session: GgtSessionRow, at: Date): number {
  return Math.max(0, (at.getTime() - new Date(session.started_at).getTime() - GGT_GRACE_MS) / 1000);
}

function isStale(session: GgtSessionRow): boolean {
  return Date.now() - new Date(session.started_at).getTime() > GGT_SESSION_STALE_MS;
}

async function toPublicSession(session: GgtSessionRow): Promise<PublicSession> {
  const [solved, total] = await Promise.all([
    guessTheGoalRepo.countSolved(session.user_id),
    guessTheGoalRepo.countPublished(),
  ]);
  const snapshot = session.goal_snapshot;
  const timings = buildTimings(snapshot.steps);
  const now = new Date();
  const payload: PublicSession = {
    session_id: session.id,
    state: session.state === 'guessed' ? 'guessed' : 'active',
    server_now: now.toISOString(),
    started_at: new Date(session.started_at).toISOString(),
    grace_ms: GGT_GRACE_MS,
    max_points: session.max_points,
    min_points: GGT_MIN_POINTS,
    goal: {
      difficulty: snapshot.difficulty,
      players: snapshot.players,
      steps: snapshot.steps,
      options: sanitizeOptions(session.id, snapshot.options),
      main_moves: timings.mainStarts.length,
      duration_seconds: Math.round(timings.duration * 10) / 10,
    },
    progress: { solved, total },
  };
  if (session.state === 'guessed') {
    payload.bonus = bonusPayload(session);
  }
  return payload;
}

/**
 * Grant first-solve rewards inside the caller's transaction. Coins respect the
 * daily faucet cap (UTC day — an anti-farm backstop, not a player-facing
 * boundary); XP always flows (idempotent via user_xp_events). The per-user
 * open-session row lock serializes settlements, so the cap read can't race.
 */
async function grantRewards(
  tx: TransactionSql,
  data: {
    userId: string;
    goalId: string;
    sessionId: string;
    points: number;
    idempotencySuffix?: string;
  }
): Promise<AwardSummary> {
  const wantedCoins = Math.floor(data.points * GGT_COINS_PER_POINT);
  const xp = Math.floor(data.points * GGT_XP_PER_POINT);

  const grantedToday = await guessTheGoalRepo.coinsGrantedToday(tx, data.userId);
  const headroom = Math.max(0, GGT_DAILY_COIN_CAP - grantedToday);
  const coins = Math.min(wantedCoins, headroom);
  const capReached = coins < wantedCoins;

  const suffix = data.idempotencySuffix ?? '';
  let walletCoins: number | null = null;
  if (coins > 0) {
    const wallet = await storeRepo.addCoinsInTx(tx, data.userId, coins);
    walletCoins = wallet?.coins ?? null;
    await storeRepo.insertTransactionLogInTx(tx, {
      eventType: GGT_REWARD_EVENT,
      outcome: 'success',
      userId: data.userId,
      coinsDelta: coins,
      reason: 'guess_the_goal_first_solve',
      idempotencyKey: `ggt:${data.userId}:${data.goalId}${suffix}`,
      metadata: { session_id: data.sessionId, points: data.points },
    });
  }
  let totalXp: number | null = null;
  if (xp > 0) {
    const granted = await progressionRepo.grantXpInTx(tx, {
      userId: data.userId,
      sourceType: GGT_XP_SOURCE,
      sourceKey: `${data.goalId}${suffix}`,
      xpDelta: xp,
      metadata: { session_id: data.sessionId, points: data.points },
    });
    totalXp = granted.totalXp;
  }

  return {
    first_solve: true,
    coins,
    xp,
    daily_cap_reached: capReached,
    wallet_coins: walletCoins,
    total_xp: totalXp,
  };
}

function storedAwards(session: GgtSessionRow, bonusShare: boolean): AwardSummary {
  return {
    first_solve: session.first_solve,
    coins: bonusShare ? 0 : session.coins_awarded,
    xp: bonusShare ? 0 : session.xp_awarded,
    daily_cap_reached: false,
    wallet_coins: null,
    total_xp: null,
  };
}

function correctOptionOf(options: ChoreographyOption[]): ChoreographyOption {
  const correct = options.find((o) => o.is_correct);
  if (!correct) throw new ConflictError('Content has no correct option');
  return correct;
}

/** Rebuild a guess outcome from the stored row — used for idempotent retries. */
function replayGuessOutcome(session: GgtSessionRow): GuessOutcome {
  const snapshot = session.goal_snapshot;
  const outcome: GuessOutcome = {
    correct: session.guess_correct ?? false,
    correct_option_id: correctOptionOf(snapshot.options).id,
    points: session.points,
    revealed_moves: session.revealed_moves ?? 0,
    title: snapshot.title,
    fun_fact: snapshot.fun_fact,
    awards: storedAwards(session, false),
    session_state: session.state === 'guessed' ? 'guessed' : 'complete',
  };
  if (session.state === 'guessed') outcome.bonus = bonusPayload(session);
  return outcome;
}

export const guessTheGoalService = {
  async startSession(userId: string, clientNonce: string | null): Promise<PublicSession> {
    // Nonce lookup BEFORE any mutation: a retried request must return the
    // session it already created, never abandon it and mint a second one.
    if (clientNonce) {
      const existing = await guessTheGoalRepo.getSessionByNonce(userId, clientNonce);
      if (existing) {
        if (existing.state === 'active' || existing.state === 'guessed') {
          return toPublicSession(existing);
        }
        throw new ConflictError('Session for this nonce already finished');
      }
    }

    const session = await sql.begin(async (tx) => {
      const open = await guessTheGoalRepo.getOpenSessionForUpdate(tx, userId);
      if (open) {
        // Starting a new goal forfeits the previous one (including a pending
        // bonus — base rewards were already settled at guess time). Scouting
        // is neutralized by the max_points clamp on repeat views.
        await guessTheGoalRepo.abandonSession(tx, open.id);
      }

      const goal = await guessTheGoalRepo.pickNextGoal(userId);
      if (!goal) throw new NotFoundError('No goals available');

      const seen = await guessTheGoalRepo.hasSeenGoal(userId, goal.id);
      const maxPoints = seen ? GGT_MIN_POINTS : GGT_MAX_POINTS;

      try {
        return await guessTheGoalRepo.insertSession(tx, {
          userId,
          goalId: goal.id,
          goalSnapshot: buildSnapshot(goal),
          maxPoints,
          clientNonce,
        });
      } catch (err) {
        // Unique-violation on the one-open-session index: a parallel start won.
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictError('A session is already starting');
        }
        throw err;
      }
    });

    return toPublicSession(session);
  },

  async getCurrent(userId: string): Promise<PublicSession> {
    const session = await guessTheGoalRepo.getOpenSession(userId);
    if (!session || (session.state === 'active' && isStale(session))) {
      throw new NotFoundError('No active session');
    }
    return toPublicSession(session);
  },

  async guess(userId: string, sessionId: string, optionId: string): Promise<GuessOutcome> {
    return sql.begin(async (tx) => {
      const session = await guessTheGoalRepo.getOpenSessionForUpdate(tx, userId);
      if (!session || session.id !== sessionId) {
        // The session may have completed on a previous attempt whose response
        // was lost — replay the stored result instead of stranding the client.
        const finished = await guessTheGoalRepo.getFinishedSession(userId, sessionId);
        if (finished && finished.guess_option_id === optionId) return replayGuessOutcome(finished);
        if (finished) throw new ConflictError('Session already guessed with a different option');
        throw new NotFoundError('No such active session');
      }
      if (session.state !== 'active') {
        if (session.guess_option_id === optionId) return replayGuessOutcome(session);
        throw new ConflictError('Session already guessed with a different option');
      }

      const snapshot = session.goal_snapshot;
      const option = snapshot.options.find((o) => o.id === optionId);
      if (!option) throw new BadRequestError('Unknown option');
      const correctOption = correctOptionOf(snapshot.options);

      const now = new Date();
      const timings = buildTimings(snapshot.steps);
      const elapsed = elapsedSeconds(session, now);
      const revealed = Math.min(
        revealedMovesAt(timings, Math.min(elapsed, timings.duration)),
        timings.mainStarts.length
      );

      const correct = option.is_correct;
      const points = correct
        ? pointsForReveal(revealed, timings.mainStarts.length, session.max_points, GGT_MIN_POINTS)
        : 0;

      const hasBonus = correct && snapshot.bonus != null;
      const nextState: 'guessed' | 'complete' = hasBonus ? 'guessed' : 'complete';

      let awards = NO_AWARDS;
      if (correct) {
        const won = await guessTheGoalRepo.insertSolve(tx, {
          userId,
          goalId: session.goal_id,
          sessionId: session.id,
        });
        if (won) {
          awards = await grantRewards(tx, {
            userId,
            goalId: session.goal_id,
            sessionId: session.id,
            points,
          });
        }
      }

      const updated = await guessTheGoalRepo.updateSession(tx, session.id, {
        state: nextState,
        guessed_at: now,
        guess_option_id: optionId,
        guess_correct: correct,
        revealed_moves: revealed,
        points,
        first_solve: awards.first_solve,
        coins_awarded: awards.coins,
        xp_awarded: awards.xp,
      });
      if (!updated) throw new ConflictError('Session update failed');

      const outcome: GuessOutcome = {
        correct,
        correct_option_id: correctOption.id,
        points,
        revealed_moves: revealed,
        title: snapshot.title,
        fun_fact: snapshot.fun_fact,
        awards,
        session_state: nextState,
      };
      if (hasBonus) outcome.bonus = bonusPayload(updated);
      return outcome;
    });
  },

  async answerBonus(userId: string, sessionId: string, optionId: string): Promise<BonusOutcome> {
    return sql.begin(async (tx) => {
      const session = await guessTheGoalRepo.getOpenSessionForUpdate(tx, userId);
      if (!session || session.id !== sessionId) {
        const finished = await guessTheGoalRepo.getFinishedSession(userId, sessionId);
        if (finished?.bonus_option_id === optionId && finished.goal_snapshot.bonus) {
          return {
            correct: finished.bonus_correct ?? false,
            correct_option_id: correctOptionOf(finished.goal_snapshot.bonus.options).id,
            bonus_points: finished.bonus_points,
            awards: storedAwards(finished, true),
          };
        }
        if (finished?.bonus_option_id) {
          throw new ConflictError('Bonus already answered with a different option');
        }
        throw new NotFoundError('No such active session');
      }
      if (session.state !== 'guessed') throw new ConflictError('No bonus pending');

      const bonus = session.goal_snapshot.bonus;
      if (!bonus) throw new ConflictError('No bonus pending');

      const option = bonus.options.find((o) => o.id === optionId);
      if (!option) throw new BadRequestError('Unknown option');
      const correctOption = correctOptionOf(bonus.options);

      const correct = option.is_correct;
      const bonusPoints = correct ? GGT_BONUS_POINTS : 0;

      let awards = NO_AWARDS;
      if (correct && session.first_solve) {
        awards = await grantRewards(tx, {
          userId,
          goalId: session.goal_id,
          sessionId: session.id,
          points: bonusPoints,
          idempotencySuffix: ':bonus',
        });
      }

      const updated = await guessTheGoalRepo.updateSession(tx, session.id, {
        state: 'complete',
        bonus_option_id: optionId,
        bonus_correct: correct,
        bonus_points: bonusPoints,
        coins_awarded: session.coins_awarded + awards.coins,
        xp_awarded: session.xp_awarded + awards.xp,
      });
      if (!updated) throw new ConflictError('Session update failed');

      return { correct, correct_option_id: correctOption.id, bonus_points: bonusPoints, awards };
    });
  },

  async getStats(userId: string): Promise<{
    solved: number;
    total: number;
    coins_today: number;
    daily_coin_cap: number;
  }> {
    const [solved, total, coinsToday] = await Promise.all([
      guessTheGoalRepo.countSolved(userId),
      guessTheGoalRepo.countPublished(),
      sql.begin((tx) => guessTheGoalRepo.coinsGrantedToday(tx, userId)),
    ]);
    return { solved, total, coins_today: coinsToday, daily_coin_cap: GGT_DAILY_COIN_CAP };
  },
};
