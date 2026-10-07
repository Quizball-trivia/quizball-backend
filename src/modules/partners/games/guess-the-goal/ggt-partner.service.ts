/** Guess the Goal for Freecroco (contract v1.2 §7.4): one goal per play, 100 points for the right goal (40 when this
 *  player was shown it in an earlier play), +40 for a right bonus answer within 30 s, a wrong main answer ends the play
 *  with 0. The main answer has no time limit; a goal left unanswered for 10 minutes is abandoned with 0 (§7: a play
 *  left early scores what it had earned). The goal is a guess_the_goal_sessions row (same snapshot, option shuffling and answer hiding as
 *  quizball.io); the partner row adds the deadlines. One score event per play, written with the result; no coins, XP
 *  or solves are ever recorded for partner players. */

import { sql, type TransactionSql } from '../../../../db/index.js';
import { logger } from '../../../../core/logger.js';
import { partnerBegin } from '../../partner-analytics.js';
import { asSql, type Db } from '../../partner-db.js';
import { PartnerError } from '../../partner-errors.js';
import type { PartnerPrincipal } from '../../partner-player-auth.js';
import type { PartnerPlay } from '../../partner-quota.service.js';
import { afterPartnerSettle, settlePartnerPlay, startPartnerPlay } from '../kit.js';
import { guessTheGoalRepo } from '../../../guess-the-goal/guess-the-goal.repo.js';
import {
  buildSnapshot,
  correctOptionOf,
  stripOptions,
  type PublicOption,
} from '../../../guess-the-goal/guess-the-goal.service.js';
import { buildTimings, revealedMovesAt } from '../../../guess-the-goal/guess-the-goal.timing.js';
import { GGT_FULL_POINTS_SECONDS, GGT_GRACE_MS } from '../../../guess-the-goal/guess-the-goal.constants.js';
import type { GgtSessionRow, GoalChoreographyRow, I18nText } from '../../../guess-the-goal/guess-the-goal.types.js';

export const PARTNER_GGT_POINTS = 100;
export const PARTNER_GGT_SEEN_POINTS = 40;
export const PARTNER_GGT_BONUS_POINTS = 40;
/** A goal nobody answers for this long counts as left: 0 points. */
export const PARTNER_GGT_IDLE_SECONDS = 10 * 60;
export const PARTNER_GGT_BONUS_SECONDS = 30;
/** Partner-wide rule: an answer that reaches us up to 1 s after its deadline still counts; expiry waits as long. */
export const PARTNER_GGT_LATE_GRACE_MS = 1_000;

interface PlayRow {
  play_id: string;
  session_id: string;
  user_id: string;
  base_points: number;
  abandon_deadline: Date;
  bonus_deadline: Date | null;
  settled_at: Date | null;
}

export interface PartnerGgtFinished {
  play_id: string;
  score: number;
  /** False when the play was cancelled (the player was blocked): no points are sent. */
  sent: boolean;
}

interface NoAwards {
  first_solve: false;
  coins: 0;
  xp: 0;
  daily_cap_reached: false;
  wallet_coins: null;
  total_xp: null;
}
// The web screen is shared with quizball.io and reads `awards`; partner plays never carry any.
const NO_AWARDS: NoAwards = { first_solve: false, coins: 0, xp: 0, daily_cap_reached: false, wallet_coins: null, total_xp: null };

export interface PartnerGgtOutcome {
  correct: boolean;
  /** The time for the answer had run out: nothing was judged. */
  timed_out: boolean;
  correct_option_id: string;
  points: number;
  revealed_moves: number;
  title: I18nText;
  fun_fact: I18nText | null;
  video_url: string | null;
  clip_start_s: number | null;
  clip_end_s: number | null;
  bonus?: { question: I18nText; options: PublicOption[] };
  bonus_deadline: string | null;
  awards: NoAwards;
  session_state: 'guessed' | 'complete';
  finished: PartnerGgtFinished | null;
}

export interface PartnerGgtBonusOutcome {
  correct: boolean;
  timed_out: boolean;
  correct_option_id: string;
  bonus_points: number;
  awards: NoAwards;
  finished: PartnerGgtFinished | null;
  /** Held back from the main reveal while the bonus is open (they often give its answer away). */
  fun_fact: I18nText | null;
  video_url: string | null;
  clip_start_s: number | null;
  clip_end_s: number | null;
}

export interface PartnerGgtSession {
  session_id: string;
  play_id: string;
  state: 'active' | 'guessed';
  server_now: string;
  started_at: string;
  grace_ms: number;
  full_points_seconds: number;
  max_points: number;
  min_points: number;
  bonus_deadline: string | null;
  goal: {
    difficulty: string;
    players: GgtSessionRow['goal_snapshot']['players'];
    steps: GgtSessionRow['goal_snapshot']['steps'];
    options: PublicOption[];
    main_moves: number;
    duration_seconds: number;
  };
  bonus?: { question: I18nText; options: PublicOption[] };
  outcome?: PartnerGgtOutcome;
  guess_option_id?: string;
  progress: { solved: number; total: number };
}

const graced = (deadline: Date): number => deadline.getTime() + PARTNER_GGT_LATE_GRACE_MS;

function bonusOf(session: GgtSessionRow): { question: I18nText; options: PublicOption[] } | undefined {
  const bonus = session.goal_snapshot.bonus;
  return bonus ? { question: bonus.question, options: stripOptions(bonus.options) } : undefined;
}

type PlayEnd = Pick<PartnerPlay, 'id' | 'state' | 'score'>;

function finishedOf(play: PlayEnd | null): PartnerGgtFinished | null {
  if (!play || play.state === 'started') return null;
  return { play_id: play.id, score: play.state === 'finished' ? (play.score ?? 0) : 0, sent: play.state === 'finished' };
}

/** The footage and fun fact: they often answer the bonus question, so they are only sent once it is closed. */
function afterBonus(session: GgtSessionRow) {
  const snapshot = session.goal_snapshot;
  return {
    fun_fact: snapshot.fun_fact,
    video_url: snapshot.mirrored_url ?? snapshot.video_url ?? null,
    clip_start_s: snapshot.clip_start_s ?? null,
    clip_end_s: snapshot.clip_end_s ?? null,
  };
}

/** Every builder that reveals content goes through this: a cancelled play shows nothing of its goal. */
function revealable(lock: Locked): void {
  if (lock.cancelled) throw new PartnerError('play_not_active');
}

/** The reveal after the main answer (or its timeout). Only ever built once the answer can no longer change. */
function outcomeOf(lock: Locked, session: GgtSessionRow, row: PlayRow, finished: PartnerGgtFinished | null): PartnerGgtOutcome {
  revealable(lock);
  const snapshot = session.goal_snapshot;
  const pendingBonus = session.state === 'guessed';
  const extras = pendingBonus ? { fun_fact: null, video_url: null, clip_start_s: null, clip_end_s: null } : afterBonus(session);
  return {
    correct: session.guess_correct ?? false,
    timed_out: session.guess_option_id == null,
    correct_option_id: correctOptionOf(snapshot.options).id,
    points: session.points,
    revealed_moves: session.revealed_moves ?? 0,
    title: snapshot.title,
    ...extras,
    ...(pendingBonus ? { bonus: bonusOf(session) } : {}),
    bonus_deadline: row.bonus_deadline?.toISOString() ?? null,
    awards: NO_AWARDS,
    session_state: pendingBonus ? 'guessed' : 'complete',
    finished,
  };
}

function sessionPayload(lock: Locked): PartnerGgtSession {
  revealable(lock);
  const { session, row } = lock;
  const snapshot = session.goal_snapshot;
  const timings = buildTimings(snapshot.steps);
  const payload: PartnerGgtSession = {
    session_id: session.id,
    play_id: row.play_id,
    state: session.state === 'guessed' ? 'guessed' : 'active',
    server_now: new Date().toISOString(),
    started_at: new Date(session.started_at).toISOString(),
    grace_ms: GGT_GRACE_MS,
    full_points_seconds: GGT_FULL_POINTS_SECONDS,
    max_points: row.base_points,
    min_points: PARTNER_GGT_SEEN_POINTS,
    bonus_deadline: row.bonus_deadline?.toISOString() ?? null,
    goal: {
      difficulty: snapshot.difficulty,
      players: snapshot.players,
      steps: snapshot.steps,
      options: stripOptions(snapshot.options),
      main_moves: timings.mainStarts.length,
      duration_seconds: Math.round(timings.duration * 10) / 10,
    },
    progress: { solved: 0, total: 0 },
  };
  if (session.state === 'guessed') {
    payload.bonus = bonusOf(session);
    payload.outcome = outcomeOf(lock, session, row, null);
    payload.guess_option_id = session.guess_option_id ?? undefined;
  }
  return payload;
}

/**
 * A play held for one request. The player row is locked first (FOR SHARE; a block takes it exclusively before it
 * cancels plays), then the game row and its session, so no block can land until the request commits: `cancelled`
 * cannot change under it, and settlement can never meet a cancellation it did not see.
 */
interface Locked {
  row: PlayRow;
  session: GgtSessionRow;
  parent: PlayEnd;
  /** Cancelled by a block (or the player is blocked with the play still running): reveal nothing, settle nothing. */
  cancelled: boolean;
}

/** Always the first lock of a request (the block path's order: player, then plays). True while the player is active. */
async function lockPlayer(tx: Db, userId: string): Promise<boolean> {
  const [player] = await tx<{ status: string }[]>`SELECT status FROM partner_players WHERE user_id = ${userId} FOR SHARE`;
  return player?.status === 'active';
}

async function lockPlay(tx: Db, userId: string, sessionId: string, opts: { skipLocked?: boolean } = {}): Promise<Locked | null> {
  const active = await lockPlayer(tx, userId);
  const [row] = opts.skipLocked
    ? await tx<PlayRow[]>`
        SELECT play_id, session_id, user_id, base_points, abandon_deadline, bonus_deadline, settled_at
        FROM partner_ggt_plays WHERE session_id = ${sessionId} AND user_id = ${userId} FOR UPDATE SKIP LOCKED`
    : await tx<PlayRow[]>`
        SELECT play_id, session_id, user_id, base_points, abandon_deadline, bonus_deadline, settled_at
        FROM partner_ggt_plays WHERE session_id = ${sessionId} AND user_id = ${userId} FOR UPDATE`;
  if (!row) {
    if (opts.skipLocked) return null;
    throw new PartnerError('not_found', 'Play not found');
  }
  const [session] = await tx<GgtSessionRow[]>`SELECT * FROM guess_the_goal_sessions WHERE id = ${sessionId} FOR UPDATE`;
  const parent = (await playOf(tx, row.play_id))!;
  return { row, session, parent, cancelled: parent.state === 'cancelled' || (!active && parent.state === 'started') };
}

async function mustLockPlay(tx: Db, userId: string, sessionId: string): Promise<Locked> {
  return (await lockPlay(tx, userId, sessionId))!;
}

async function playOf(tx: Db, playId: string): Promise<PlayEnd | null> {
  const [row] = await tx<PlayEnd[]>`SELECT id, state, score FROM partner_plays WHERE id = ${playId}`;
  return row ?? null;
}

/**
 * A block cancels the parent play (contract §5.5: no event, the play stays used). Close this player's game rows of
 * cancelled plays and abandon their borrowed sessions in a transaction of its own, before anything reads them as
 * playable (an unblocked player must not resume a cancelled play).
 */
async function closeCancelled(userId: string): Promise<void> {
  await partnerBegin(async (t) => {
    const tx = asSql(t);
    const rows = await tx<{ play_id: string; session_id: string }[]>`
      SELECT g.play_id, g.session_id FROM partner_ggt_plays g
      JOIN partner_plays p ON p.id = g.play_id
      WHERE g.user_id = ${userId} AND g.settled_at IS NULL AND p.state = 'cancelled'
      FOR UPDATE OF g`;
    for (const row of rows) {
      await tx`UPDATE partner_ggt_plays SET settled_at = clock_timestamp() WHERE play_id = ${row.play_id}`;
      await tx`UPDATE guess_the_goal_sessions SET state = 'abandoned' WHERE id = ${row.session_id} AND state IN ('active', 'guessed')`;
    }
  });
}

/** Ends the play inside the result transaction: one score event, at the logical end `at`. Callers hold the player
 *  lock and saw the play running, so a block cannot cancel it here; if it ever did, nothing is revealed or kept. */
async function settle(tx: Db, row: PlayRow, score: number, at: Date): Promise<PartnerPlay> {
  await tx`UPDATE partner_ggt_plays SET settled_at = clock_timestamp() WHERE play_id = ${row.play_id}`;
  const play = await settlePartnerPlay(tx as unknown as TransactionSql, row.play_id, score, at);
  if (play.state === 'cancelled') throw new PartnerError('play_not_active');
  return play;
}

/** Settles the play if its pending deadline plus the transit grace has passed; null when still open. The score event
 *  is dated at the deadline itself. */
async function settleIfOverdue(tx: Db, row: PlayRow, session: GgtSessionRow, now: number): Promise<PartnerPlay | null> {
  if (row.settled_at) return null;
  const due = (deadline: Date) => now >= graced(deadline);
  if (session.state === 'active' && due(row.abandon_deadline)) {
    await tx`UPDATE guess_the_goal_sessions SET state = 'abandoned', points = 0 WHERE id = ${session.id}`;
    return settle(tx, row, 0, row.abandon_deadline);
  }
  if (session.state === 'guessed' && row.bonus_deadline && due(row.bonus_deadline)) {
    await tx`UPDATE guess_the_goal_sessions SET state = 'complete', bonus_points = 0 WHERE id = ${session.id}`;
    return settle(tx, row, row.base_points, row.bonus_deadline);
  }
  return null;
}

/** Never-seen goals first, then the one seen longest ago; random within a tier. No curated intro order: every
 *  Freecroco player starting on the same famous goals would make answers trivially shareable. */
async function pickGoal(tx: Db, userId: string): Promise<GoalChoreographyRow | null> {
  const [goal] = await tx<GoalChoreographyRow[]>`
    SELECT g.* FROM goal_choreographies g
    WHERE g.status = 'published'
    ORDER BY (SELECT max(s.started_at) FROM guess_the_goal_sessions s WHERE s.user_id = ${userId} AND s.goal_id = g.id)
             ASC NULLS FIRST,
             random()
    LIMIT 1`;
  return goal ?? null;
}

async function openRow(tx: Db, userId: string): Promise<PlayRow | null> {
  const [row] = await tx<PlayRow[]>`
    SELECT play_id, session_id, user_id, base_points, abandon_deadline, bonus_deadline, settled_at
    FROM partner_ggt_plays WHERE user_id = ${userId} AND settled_at IS NULL
    ORDER BY created_at DESC LIMIT 1`;
  return row ?? null;
}

export interface PartnerGgtView {
  /** The open play, or null once it ended. */
  session: PartnerGgtSession | null;
  finished: PartnerGgtFinished | null;
  outcome: PartnerGgtOutcome | null;
  bonus: PartnerGgtBonusOutcome | null;
}

/** The full reveal of an ended play: its main outcome and, when a right answer opened one, the bonus outcome. */
async function endedView(
  tx: Db,
  lock: Locked,
  finished: PartnerGgtFinished,
): Promise<{ finished: PartnerGgtFinished; outcome: PartnerGgtOutcome; bonus: PartnerGgtBonusOutcome | null }> {
  revealable(lock);
  const row = lock.row;
  const [after] = await tx<GgtSessionRow[]>`SELECT * FROM guess_the_goal_sessions WHERE id = ${lock.session.id}`;
  const bonus = after.goal_snapshot.bonus && after.guess_correct
    ? {
        correct: after.bonus_correct ?? false,
        timed_out: after.bonus_option_id == null,
        correct_option_id: correctOptionOf(after.goal_snapshot.bonus.options).id,
        bonus_points: after.bonus_points,
        awards: NO_AWARDS,
        finished,
        ...afterBonus(after),
      }
    : null;
  return { finished, outcome: outcomeOf(lock, after, row, finished), bonus };
}

export const partnerGuessTheGoalService = {
  /** The open play (settling it first if its time ran out), or null. */
  async current(partner: PartnerPrincipal): Promise<{ session: PartnerGgtSession | null; finished: PartnerGgtFinished | null }> {
    await closeCancelled(partner.userId);
    const result = await partnerBegin(async (t) => {
      const tx = asSql(t);
      const open = await openRow(tx, partner.userId);
      if (!open) return { session: null, finished: null, settled: false };
      const lock = await mustLockPlay(tx, partner.userId, open.session_id);
      if (lock.cancelled) return { session: null, finished: null, settled: false };
      const { row, session } = lock;
      const ended = await settleIfOverdue(tx, row, session, Date.now());
      if (ended || row.settled_at) return { session: null, finished: finishedOf(ended), settled: Boolean(ended) };
      return { session: sessionPayload(lock), finished: null, settled: false };
    });
    if (result.settled) afterPartnerSettle();
    return { session: result.session, finished: result.finished };
  },

  /** Starts today's play, or returns the open one (a retried or second start never reserves twice). */
  async start(partner: PartnerPrincipal, clientNonce: string): Promise<PartnerGgtSession> {
    const open = await this.current(partner);
    if (open.session) return open.session;

    const { result } = await startPartnerPlay(partner, 'guess-the-goal', `${partner.playerId}:${clientNonce}`, async (t, play) => {
      const tx = asSql(t);
      const [existing] = await tx<PlayRow[]>`
        SELECT play_id, session_id, user_id, base_points, abandon_deadline, bonus_deadline, settled_at
        FROM partner_ggt_plays WHERE play_id = ${play.id}`;
      if (existing) {
        const lock = await mustLockPlay(tx, partner.userId, existing.session_id);
        if (lock.row.settled_at || lock.parent.state !== 'started') throw new PartnerError('play_not_active');
        return sessionPayload(lock);
      }
      if (play.state !== 'started') throw new PartnerError('play_not_active');

      await guessTheGoalRepo.acquireUserStartLock(t, partner.userId);
      // A start racing this one (different nonce) already holds the open goal.
      if (await guessTheGoalRepo.getOpenSessionForUpdate(t, partner.userId)) {
        throw new PartnerError('request_conflict', 'A goal is already in progress');
      }
      const goal = await pickGoal(tx, partner.userId);
      // Rolls the reservation back with it: no goal, no play used.
      if (!goal) throw new PartnerError('game_not_available');
      const seen = await guessTheGoalRepo.hasSeenGoal(t, partner.userId, goal.id);
      const basePoints = seen ? PARTNER_GGT_SEEN_POINTS : PARTNER_GGT_POINTS;
      const session = await guessTheGoalRepo.insertSession(t, {
        userId: partner.userId,
        goalId: goal.id,
        goalSnapshot: buildSnapshot(goal),
        maxPoints: basePoints,
        clientNonce: null,
      });
      await tx`
        INSERT INTO partner_ggt_plays (play_id, session_id, user_id, base_points, abandon_deadline)
        VALUES (${play.id}, ${session.id}, ${partner.userId}, ${basePoints},
                ${session.started_at}::timestamptz + make_interval(secs => ${PARTNER_GGT_IDLE_SECONDS}))`;
      return sessionPayload(await mustLockPlay(tx, partner.userId, session.id));
    });
    return result;
  },

  async guess(partner: PartnerPrincipal, sessionId: string, optionId: string): Promise<PartnerGgtOutcome> {
    await closeCancelled(partner.userId);
    const result = await partnerBegin(async (t) => {
      const tx = asSql(t);
      const lock = await mustLockPlay(tx, partner.userId, sessionId);
      if (lock.cancelled) throw new PartnerError('play_not_active');
      const { row, session } = lock;
      if (session.state !== 'active') {
        // A retried answer (lost response) gets the stored result, an answer after the timeout settled the play
        // gets the timeout; an answer to a goal already answered differently is refused.
        if (session.guess_option_id === optionId || (session.guess_option_id == null && row.settled_at)) {
          return { outcome: outcomeOf(lock, session, row, finishedOf(lock.parent)), settled: false };
        }
        throw new PartnerError('play_not_active');
      }
      const now = Date.now();
      const timedOut = await settleIfOverdue(tx, row, session, now);
      if (timedOut) {
        const [after] = await tx<GgtSessionRow[]>`SELECT * FROM guess_the_goal_sessions WHERE id = ${session.id}`;
        return { outcome: outcomeOf(lock, after, row, finishedOf(timedOut)), settled: true };
      }

      const snapshot = session.goal_snapshot;
      const option = snapshot.options.find((o) => o.id === optionId);
      if (!option) throw new PartnerError('invalid_request', 'option_id: unknown option');
      const timings = buildTimings(snapshot.steps);
      const elapsed = Math.max(0, (now - new Date(session.started_at).getTime() - GGT_GRACE_MS) / 1000);
      const revealed = Math.min(revealedMovesAt(timings, Math.min(elapsed, timings.duration)), timings.mainStarts.length);
      const correct = option.is_correct;
      const points = correct ? row.base_points : 0;
      const hasBonus = correct && snapshot.bonus != null;

      const at = new Date(now);
      const updated = await guessTheGoalRepo.updateSession(t, session.id, {
        state: hasBonus ? 'guessed' : 'complete',
        guessed_at: at,
        guess_option_id: optionId,
        guess_correct: correct,
        revealed_moves: revealed,
        points,
      });
      if (!updated) throw new PartnerError('internal_error');

      if (hasBonus) {
        const [withBonus] = await tx<PlayRow[]>`
          UPDATE partner_ggt_plays
          SET bonus_deadline = ${at}::timestamptz + make_interval(secs => ${PARTNER_GGT_BONUS_SECONDS})
          WHERE play_id = ${row.play_id}
          RETURNING play_id, session_id, user_id, base_points, abandon_deadline, bonus_deadline, settled_at`;
        return { outcome: outcomeOf(lock, updated, withBonus, null), settled: false };
      }
      const play = await settle(tx, row, points, at);
      return { outcome: outcomeOf(lock, updated, row, finishedOf(play)), settled: true };
    });
    if (result.settled) afterPartnerSettle();
    return result.outcome;
  },

  async answerBonus(partner: PartnerPrincipal, sessionId: string, optionId: string): Promise<PartnerGgtBonusOutcome> {
    await closeCancelled(partner.userId);
    const result = await partnerBegin(async (t) => {
      const tx = asSql(t);
      const lock = await mustLockPlay(tx, partner.userId, sessionId);
      if (lock.cancelled) throw new PartnerError('play_not_active');
      const { row, session } = lock;
      const bonus = session.goal_snapshot.bonus;
      if (!bonus) throw new PartnerError('play_not_active');
      const correctId = correctOptionOf(bonus.options).id;
      if (session.state !== 'guessed') {
        // A bonus that timed out answers with the timeout; a goal answered wrong never had a bonus.
        if (session.state === 'complete' && session.guess_correct && (session.bonus_option_id === optionId || session.bonus_option_id == null)) {
          return {
            outcome: {
              correct: session.bonus_correct ?? false,
              timed_out: session.bonus_option_id == null,
              correct_option_id: correctId,
              bonus_points: session.bonus_points,
              awards: NO_AWARDS,
              finished: finishedOf(lock.parent),
              ...afterBonus(session),
            },
            settled: false,
          };
        }
        throw new PartnerError('play_not_active');
      }
      const now = Date.now();
      const timedOut = await settleIfOverdue(tx, row, session, now);
      if (timedOut) {
        return {
          outcome: {
            correct: false,
            timed_out: true,
            correct_option_id: correctId,
            bonus_points: 0,
            awards: NO_AWARDS,
            finished: finishedOf(timedOut),
            ...afterBonus(session),
          },
          settled: true,
        };
      }
      const option = bonus.options.find((o) => o.id === optionId);
      if (!option) throw new PartnerError('invalid_request', 'option_id: unknown option');
      const bonusPoints = option.is_correct ? PARTNER_GGT_BONUS_POINTS : 0;
      const updated = await guessTheGoalRepo.updateSession(t, session.id, {
        state: 'complete',
        bonus_option_id: optionId,
        bonus_correct: option.is_correct,
        bonus_points: bonusPoints,
      });
      if (!updated) throw new PartnerError('internal_error');
      const play = await settle(tx, row, row.base_points + bonusPoints, new Date(now));
      return {
        outcome: {
          correct: option.is_correct,
          timed_out: false,
          correct_option_id: correctId,
          bonus_points: bonusPoints,
          awards: NO_AWARDS,
          finished: finishedOf(play),
          ...afterBonus(session),
        },
        settled: true,
      };
    });
    if (result.settled) afterPartnerSettle();
    return result.outcome;
  },

  /** The bonus countdown reached 0: settle now instead of waiting for the sweeper. Refused until the deadline plus the
   *  1 s grace has passed (answers are accepted until then). */
  async expire(
    partner: PartnerPrincipal,
    sessionId: string,
  ): Promise<{ finished: PartnerGgtFinished; outcome: PartnerGgtOutcome; bonus: PartnerGgtBonusOutcome | null }> {
    await closeCancelled(partner.userId);
    const result = await partnerBegin(async (t) => {
      const tx = asSql(t);
      const lock = await mustLockPlay(tx, partner.userId, sessionId);
      if (lock.cancelled) throw new PartnerError('play_not_active');
      const { row, session } = lock;
      // Same cut-off as answers (deadline + transit grace), so a play can never score differently by who asks first.
      const ended = row.settled_at ? lock.parent : await settleIfOverdue(tx, row, session, Date.now());
      if (!ended) throw new PartnerError('invalid_request', 'The time has not run out yet');
      return { value: await endedView(tx, lock, finishedOf(ended)!), settled: !row.settled_at };
    });
    if (result.settled) afterPartnerSettle();
    return result.value;
  },

  /** One play by its session, finished ones included (settling it first if its time ran out): how the screen recovers
   *  a lost or refused response. A play a block cancelled reports only that it ended, unscored. */
  async get(partner: PartnerPrincipal, sessionId: string): Promise<PartnerGgtView> {
    await closeCancelled(partner.userId);
    const result = await partnerBegin(async (t) => {
      const tx = asSql(t);
      const lock = await mustLockPlay(tx, partner.userId, sessionId);
      if (lock.cancelled) {
        // Only that it ended, unscored: nothing of the goal.
        return { value: { session: null, finished: { play_id: lock.row.play_id, score: 0, sent: false }, outcome: null, bonus: null }, settled: false };
      }
      const { row, session } = lock;
      const ended = row.settled_at ? lock.parent : await settleIfOverdue(tx, row, session, Date.now());
      if (!ended) return { value: { session: sessionPayload(lock), finished: null, outcome: null, bonus: null }, settled: false };
      return { value: { session: null, ...(await endedView(tx, lock, finishedOf(ended)!)) }, settled: !row.settled_at };
    });
    if (result.settled) afterPartnerSettle();
    return result.value;
  },

  /** Sweeper: settles plays whose deadline (plus the 1 s grace) passed with nobody answering, and closes plays a block
   *  cancelled. */
  async sweepOverdue(limit = 100): Promise<number> {
    const due = await sql<{ play_id: string; session_id: string; user_id: string }[]>`
      SELECT p.play_id, p.session_id, p.user_id
      FROM partner_ggt_plays p
      JOIN guess_the_goal_sessions s ON s.id = p.session_id
      WHERE p.settled_at IS NULL
        AND ((s.state = 'active' AND p.abandon_deadline < clock_timestamp() - make_interval(secs => ${PARTNER_GGT_LATE_GRACE_MS / 1000}))
          OR (s.state = 'guessed' AND p.bonus_deadline < clock_timestamp() - make_interval(secs => ${PARTNER_GGT_LATE_GRACE_MS / 1000}))
          OR EXISTS (SELECT 1 FROM partner_plays pp WHERE pp.id = p.play_id AND pp.state = 'cancelled'))
      ORDER BY p.abandon_deadline
      LIMIT ${limit}`;
    let settled = 0;
    for (const candidate of due) {
      const done = await partnerBegin(async (t) => {
        const tx = asSql(t);
        // SKIP LOCKED: a player answering right now, or another replica's sweeper, owns the row.
        const lock = await lockPlay(tx, candidate.user_id, candidate.session_id, { skipLocked: true });
        if (!lock || lock.row.settled_at) return false;
        if (lock.cancelled) {
          // Closed without an event; a running play of a blocked player is cancelled by the block itself.
          if (lock.parent.state !== 'cancelled') return false;
          await tx`UPDATE partner_ggt_plays SET settled_at = clock_timestamp() WHERE play_id = ${lock.row.play_id}`;
          await tx`UPDATE guess_the_goal_sessions SET state = 'abandoned' WHERE id = ${lock.session.id} AND state IN ('active', 'guessed')`;
          return true;
        }
        return Boolean(await settleIfOverdue(tx, lock.row, lock.session, Date.now()));
      }).catch((err) => {
        // One failing play must not hold back the rest of the batch on every run.
        logger.error({ err, sessionId: candidate.session_id }, 'Partner Guess the Goal sweep failed for a play');
        return false;
      });
      if (done) settled += 1;
    }
    if (settled > 0) afterPartnerSettle();
    return settled;
  },
};
