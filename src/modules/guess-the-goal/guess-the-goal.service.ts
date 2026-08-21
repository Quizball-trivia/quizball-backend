import { randomInt } from 'node:crypto';
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
  GGT_XP_PER_POINT,
  GGT_XP_SOURCE,
} from './guess-the-goal.constants.js';
import type {
  ChoreographyOption,
  ChoreographyPlayer,
  ChoreographyStep,
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
  /** Present when state = 'guessed': the already-settled reveal, so a client
   *  that refreshes mid-session can restore the full outcome (title, fact,
   *  points, video). Safe — the guess has been made. */
  outcome?: GuessOutcome;
  guess_option_id?: string;
  progress: { solved: number; total: number };
}

interface AwardSummary {
  first_solve: boolean;
  coins: number;
  xp: number;
  daily_cap_reached: boolean;
  /** Authoritative balances after settlement, for client reconciliation.
   *  Null on replays — the client keeps its already-reconciled values. */
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
  /** Real footage — only ever exposed AFTER the guess. */
  video_url: string | null;
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

function fisherYates<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Anonymize an option set at SNAPSHOT time: shuffled once, re-keyed to
 * position-based ids. Authored ids/order (e.g. correct answers always written
 * first as 'a') must never be observable — a stable authored id would let a
 * client answer without ever watching the replay.
 */
function anonymizeOptions(options: ChoreographyOption[], prefix: string): ChoreographyOption[] {
  return fisherYates(options).map((o, i) => ({
    id: `${prefix}${i + 1}`,
    text: { en: o.text.en, ka: o.text.ka ?? null },
    is_correct: o.is_correct,
  }));
}

/**
 * Build the immutable per-session snapshot with EXPLICIT field construction —
 * spreading DB rows would fail open and leak any extra authored fields.
 * Meaningful player ids ('maradona') become p1..pN; a step referencing an
 * unknown player aborts the start loudly rather than leaking the id.
 */
function buildSnapshot(goal: GoalChoreographyRow): GoalSnapshot {
  const idMap = new Map<string, string>();
  const players: ChoreographyPlayer[] = goal.players.map((p, i) => {
    const anon = `p${i + 1}`;
    idMap.set(p.id, anon);
    return { id: anon, team: p.team, at: [p.at[0], p.at[1]] };
  });
  const steps: ChoreographyStep[] = goal.steps.map((s, i) => {
    const anon = idMap.get(s.player);
    if (!anon) {
      throw new ConflictError(`Choreography ${goal.slug} step ${i} references unknown player`);
    }
    const step: ChoreographyStep = {
      kind: s.kind,
      player: anon,
      to: [s.to[0], s.to[1]],
      duration: s.duration,
    };
    if (s.via) step.via = [s.via[0], s.via[1]];
    if (s.loft !== undefined) step.loft = s.loft;
    if (s.withPrev !== undefined) step.withPrev = s.withPrev;
    return step;
  });
  return {
    difficulty: goal.difficulty,
    title: { en: goal.title.en, ka: goal.title.ka ?? null },
    fun_fact: goal.fun_fact ? { en: goal.fun_fact.en, ka: goal.fun_fact.ka ?? null } : null,
    video_url: goal.video_url ?? null,
    players,
    steps,
    options: anonymizeOptions(goal.options, 'o'),
    bonus: goal.bonus
      ? {
          question: { en: goal.bonus.question.en, ka: goal.bonus.question.ka ?? null },
          options: anonymizeOptions(goal.bonus.options, 'b'),
        }
      : null,
  };
}

/** Snapshot order is already randomized — serving strips correctness only. */
function stripOptions(options: ChoreographyOption[]): PublicOption[] {
  return options.map((o) => ({ id: o.id, text: o.text }));
}

function bonusPayload(
  session: GgtSessionRow
): { question: I18nText; options: PublicOption[] } | undefined {
  const bonus = session.goal_snapshot.bonus;
  if (!bonus) return undefined;
  return { question: bonus.question, options: stripOptions(bonus.options) };
}

function elapsedSeconds(session: GgtSessionRow, at: Date): number {
  return Math.max(0, (at.getTime() - new Date(session.started_at).getTime() - GGT_GRACE_MS) / 1000);
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
      options: stripOptions(snapshot.options),
      main_moves: timings.mainStarts.length,
      duration_seconds: Math.round(timings.duration * 10) / 10,
    },
    progress: { solved, total },
  };
  if (session.state === 'guessed') {
    payload.bonus = bonusPayload(session);
    payload.outcome = replayGuessOutcome(session);
    payload.guess_option_id = session.guess_option_id ?? undefined;
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

function mainAwards(session: GgtSessionRow): AwardSummary {
  return {
    first_solve: session.first_solve,
    coins: session.coins_awarded,
    xp: session.xp_awarded,
    daily_cap_reached: false,
    wallet_coins: null,
    total_xp: null,
  };
}

function bonusAwards(session: GgtSessionRow): AwardSummary {
  return {
    first_solve: session.first_solve,
    coins: session.bonus_coins_awarded,
    xp: session.bonus_xp_awarded,
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
    video_url: snapshot.video_url ?? null,
    awards: mainAwards(session),
    session_state: session.state === 'guessed' ? 'guessed' : 'complete',
  };
  if (session.state === 'guessed') outcome.bonus = bonusPayload(session);
  return outcome;
}

export const guessTheGoalService = {
  async startSession(userId: string, clientNonce: string | null): Promise<PublicSession> {
    const session = await sql.begin(async (tx) => {
      // Serialize per-user starts: without this, two parallel starts race the
      // nonce lookup and the abandon step (one could abandon the other's
      // freshly created session and still 201 both).
      await guessTheGoalRepo.acquireUserStartLock(tx, userId);

      if (clientNonce) {
        const existing = await guessTheGoalRepo.getSessionByNonce(tx, userId, clientNonce);
        if (existing) {
          if (existing.state === 'active' || existing.state === 'guessed') return existing;
          // Nonce exists but the session already finished — treat the retry
          // as satisfied rather than silently starting a fresh session.
          throw new ConflictError('Session for this nonce already finished');
        }
      }

      const open = await guessTheGoalRepo.getOpenSessionForUpdate(tx, userId);
      if (open) {
        // Starting a new goal forfeits the previous one (including a pending
        // bonus — base rewards were already settled at guess time). Scouting
        // is neutralized by the max_points clamp on repeat views.
        await guessTheGoalRepo.abandonSession(tx, open.id);
      }

      const goal = await guessTheGoalRepo.pickNextGoal(tx, userId);
      if (!goal) throw new NotFoundError('No goals available');

      const seen = await guessTheGoalRepo.hasSeenGoal(tx, userId, goal.id);
      const maxPoints = seen ? GGT_MIN_POINTS : GGT_MAX_POINTS;

      return guessTheGoalRepo.insertSession(tx, {
        userId,
        goalId: goal.id,
        goalSnapshot: buildSnapshot(goal),
        maxPoints,
        clientNonce,
      });
    });

    return toPublicSession(session);
  },

  async getCurrent(userId: string): Promise<PublicSession> {
    const session = await guessTheGoalRepo.getOpenSession(userId);
    if (!session) throw new NotFoundError('No active session');
    return toPublicSession(session);
  },

  async guess(userId: string, sessionId: string, optionId: string): Promise<GuessOutcome> {
    return sql.begin(async (tx) => {
      const session = await guessTheGoalRepo.getOpenSessionForUpdate(tx, userId);
      if (!session || session.id !== sessionId) {
        // The session may have completed on a previous attempt whose response
        // was lost — replay the stored result instead of stranding the client.
        const finished = await guessTheGoalRepo.getFinishedSession(tx, userId, sessionId);
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
        video_url: snapshot.video_url ?? null,
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
        const finished = await guessTheGoalRepo.getFinishedSession(tx, userId, sessionId);
        if (finished?.bonus_option_id === optionId && finished.goal_snapshot.bonus) {
          return {
            correct: finished.bonus_correct ?? false,
            correct_option_id: correctOptionOf(finished.goal_snapshot.bonus.options).id,
            bonus_points: finished.bonus_points,
            awards: bonusAwards(finished),
          };
        }
        if (finished?.bonus_option_id) {
          throw new ConflictError('Bonus already answered with a different option');
        }
        throw new NotFoundError('No such active session');
      }
      if (session.state !== 'guessed') {
        if (session.bonus_option_id === optionId) {
          return {
            correct: session.bonus_correct ?? false,
            correct_option_id: session.goal_snapshot.bonus
              ? correctOptionOf(session.goal_snapshot.bonus.options).id
              : optionId,
            bonus_points: session.bonus_points,
            awards: bonusAwards(session),
          };
        }
        throw new ConflictError('No bonus pending');
      }

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
        bonus_coins_awarded: awards.coins,
        bonus_xp_awarded: awards.xp,
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
