/** Freecroco Road to Goal (contract §7.5): the site's eleven-zone ladder as a free skill game. Starts at 100 points;
 *  a right answer always clears the zone (no luck roll), clearing zone n makes the value floor(100 × multiplier n);
 *  after each cleared zone the player continues or cashes out. A wrong answer, a question timeout or leaving during
 *  a question scores 0; a decision timeout or leaving at the decision cashes out; clearing zone 11 scores 400. */

import { sql, type TransactionSql } from '../../../../db/index.js';
import { partnerBegin } from '../../partner-analytics.js';
import type { I18nField } from '../../../../db/types.js';
import { logger } from '../../../../core/logger.js';
import { asSql } from '../../partner-db.js';
import { PartnerError } from '../../partner-errors.js';
import type { PartnerPrincipal } from '../../partner-player-auth.js';
import { afterPartnerSettle, settlePartnerPlay } from '../kit.js';
import { lockPlayerFirst, startPartnerRun } from './partner-start.js';
import {
  ROAD_TO_GOAL_CANDIDATES_PER_DIFFICULTY,
  ROAD_TO_GOAL_DECISION_MS,
  ROAD_TO_GOAL_MULTIPLIERS_BP,
  ROAD_TO_GOAL_QUESTION_MS,
  ROAD_TO_GOAL_UNSEEN_MAX_CANDIDATE_PAGES,
  ROAD_TO_GOAL_ZONES,
  multiplierBpForClearedZones,
} from '../../../road-to-goal/road-to-goal.constants.js';
import { roadToGoalRepo } from '../../../road-to-goal/road-to-goal.repo.js';
import { buildRoadToGoalQuestionSet } from '../../../road-to-goal/road-to-goal.questions.js';
import type {
  RoadToGoalDifficulty,
  RoadToGoalQuestionCandidate,
  RoadToGoalQuestionImage,
} from '../../../road-to-goal/road-to-goal.types.js';

export const PARTNER_RTG_GAME_ID = 'road-to-goal' as const;
export const PARTNER_RTG_START_POINTS = 100;
/** Contract §7: an answer reaching us up to 1 s after the visible deadline still counts (quizball.io keeps 1.5 s). */
export const PARTNER_ANSWER_GRACE_MS = 1_000;
const SERVER_WINDOW_SECONDS = (ROAD_TO_GOAL_QUESTION_MS + PARTNER_ANSWER_GRACE_MS) / 1000;
/** Questions dealt in the player's recent partner runs are skipped while the pool allows it. */
const RECENT_RUNS_EXCLUDED = 30;
const SWEEP_BATCH = 50;

type RunStatus = 'active' | 'cashed' | 'lost' | 'completed' | 'cancelled';
type RunPhase = 'question' | 'decision' | 'settled';
type SettlementReason =
  | 'cashout'
  | 'completed'
  | 'wrong_answer'
  | 'question_timeout'
  | 'decision_timeout'
  | 'left_question'
  | 'left_decision'
  | 'play_cancelled';

interface StoredQuestion {
  question_id: string;
  difficulty: RoadToGoalDifficulty;
  prompt: I18nField;
  image?: RoadToGoalQuestionImage;
  options: Array<{ id: string; text: I18nField }>;
  correct_option_id: string;
}

interface LastAnswer {
  question_id: string;
  option_id: string | null;
  correct_option_id: string;
  outcome: 'correct' | 'wrong' | 'late';
}

interface RunRow {
  id: string;
  play_id: string;
  player_id: string;
  status: RunStatus;
  phase: RunPhase;
  state_version: number;
  cleared_zones: number;
  questions: StoredQuestion[];
  question_deadline_at: Date | null;
  decision_deadline_at: Date | null;
  last_answer: LastAnswer | null;
  score: number | null;
  settlement_reason: SettlementReason | null;
  db_now: Date;
  question_expired: boolean;
  decision_expired: boolean;
  play_state: 'started' | 'finished' | 'cancelled';
}

export interface PartnerRoadToGoalState {
  run_id: string;
  play_id: string;
  status: RunStatus;
  phase: RunPhase;
  state_version: number;
  start_points: number;
  cleared_zones: number;
  total_zones: number;
  zone_multipliers_bp: readonly number[];
  current_multiplier_bp: number;
  next_multiplier_bp: number | null;
  current_points: number;
  next_points: number | null;
  decision_deadline_at: string | null;
  question: {
    question_id: string;
    zone: number;
    difficulty: RoadToGoalDifficulty;
    prompt: I18nField;
    image: RoadToGoalQuestionImage | null;
    options: Array<{ id: string; text: I18nField }>;
    duration_ms: number;
    /** The visible deadline; the server accepts answers for a short network grace after it. */
    deadline_at: string;
  } | null;
  /** The answer just given, revealed only once the zone is closed. */
  last_answer: LastAnswer | null;
  score: number | null;
  settlement_reason: SettlementReason | null;
  server_now: string;
}

export interface PartnerRoadToGoalAnswerResult {
  outcome: 'correct' | 'wrong' | 'late';
  correct_option_id: string;
  state: PartnerRoadToGoalState;
}

/** floor(100 × multiplier of the last cleared zone); 100 before any zone. */
export function partnerRoadToGoalPoints(clearedZones: number): number {
  return Math.floor((PARTNER_RTG_START_POINTS * multiplierBpForClearedZones(clearedZones)) / 10_000);
}

const RUN_COLUMNS = (db: ReturnType<typeof asSql>) => db`
  r.*, p.state AS play_state, clock_timestamp() AS db_now,
  (r.phase = 'question' AND r.question_deadline_at <= clock_timestamp()) AS question_expired,
  (r.phase = 'decision' AND r.decision_deadline_at <= clock_timestamp()) AS decision_expired`;

async function lockRun(tx: TransactionSql, playerId: string, runId: string, skipLocked = false): Promise<RunRow | null> {
  const db = asSql(tx);
  const [row] = await db<RunRow[]>`
    SELECT ${RUN_COLUMNS(db)} FROM partner_rtg_runs r JOIN partner_plays p ON p.id = r.play_id
    WHERE r.id = ${runId} AND r.player_id = ${playerId}
    FOR UPDATE OF r ${skipLocked ? db`SKIP LOCKED` : db``}`;
  return row ?? null;
}

async function relock(tx: TransactionSql, row: RunRow): Promise<RunRow> {
  return (await lockRun(tx, row.player_id, row.id))!;
}

/** A block cancelled the play: the run closes with no points (and no event). */
async function markCancelled(tx: TransactionSql, row: RunRow): Promise<RunRow> {
  await asSql(tx)`
    UPDATE partner_rtg_runs
    SET status = 'cancelled', phase = 'settled', score = NULL, settlement_reason = 'play_cancelled',
        question_deadline_at = NULL, decision_deadline_at = NULL, state_version = state_version + 1,
        settled_at = COALESCE(settled_at, clock_timestamp()), updated_at = clock_timestamp()
    WHERE id = ${row.id}`;
  return relock(tx, row);
}

function toPublicState(row: RunRow): PartnerRoadToGoalState {
  const active = row.status === 'active';
  const question = row.phase === 'question' && row.question_deadline_at ? row.questions[row.cleared_zones] : null;
  return {
    run_id: row.id,
    play_id: row.play_id,
    status: row.status,
    phase: row.phase,
    state_version: row.state_version,
    start_points: PARTNER_RTG_START_POINTS,
    cleared_zones: row.cleared_zones,
    total_zones: ROAD_TO_GOAL_ZONES,
    zone_multipliers_bp: ROAD_TO_GOAL_MULTIPLIERS_BP,
    current_multiplier_bp: multiplierBpForClearedZones(row.cleared_zones),
    next_multiplier_bp: active ? ROAD_TO_GOAL_MULTIPLIERS_BP[row.cleared_zones] ?? null : null,
    current_points: active ? partnerRoadToGoalPoints(row.cleared_zones) : row.score ?? 0,
    next_points: active && row.cleared_zones < ROAD_TO_GOAL_ZONES ? partnerRoadToGoalPoints(row.cleared_zones + 1) : null,
    decision_deadline_at: active && row.phase === 'decision' ? row.decision_deadline_at?.toISOString() ?? null : null,
    question: question && row.question_deadline_at
      ? {
          question_id: question.question_id,
          zone: row.cleared_zones + 1,
          difficulty: question.difficulty,
          prompt: question.prompt,
          image: question.image ?? null,
          options: question.options,
          duration_ms: ROAD_TO_GOAL_QUESTION_MS,
          deadline_at: new Date(row.question_deadline_at.getTime() - PARTNER_ANSWER_GRACE_MS).toISOString(),
        }
      : null,
    last_answer: row.last_answer,
    score: row.score,
    settlement_reason: row.settlement_reason,
    server_now: row.db_now.toISOString(),
  };
}

function assertVersion(row: RunRow, expectedVersion: number): void {
  if (row.state_version !== expectedVersion) throw new PartnerError('stale_version', 'The run changed; reload it');
}

/** Ends the run and its play in the caller's transaction (one score event, `at` = when the play logically ended). */
async function settleRun(
  tx: TransactionSql,
  row: RunRow,
  input: { status: Exclude<RunStatus, 'active'>; reason: SettlementReason; score: number; at?: Date; lastAnswer?: LastAnswer },
): Promise<RunRow> {
  const db = asSql(tx);
  await db`
    UPDATE partner_rtg_runs
    SET status = ${input.status}, phase = 'settled', score = ${input.score}, settlement_reason = ${input.reason},
        last_answer = ${input.lastAnswer ? db.json(input.lastAnswer as never) : row.last_answer ? db.json(row.last_answer as never) : null},
        question_deadline_at = NULL, decision_deadline_at = NULL, state_version = state_version + 1,
        settled_at = COALESCE(${input.at ?? null}::timestamptz, clock_timestamp()), updated_at = clock_timestamp()
    WHERE id = ${row.id}`;
  const play = await settlePartnerPlay(tx, row.play_id, input.score, input.at, undefined, { endCause: input.reason });
  if (play.state === 'cancelled') return markCancelled(tx, row);
  return relock(tx, row);
}

/** A deadline that has passed settles the run as the rules say: question → 0, decision → cash out. */
async function resolveExpired(tx: TransactionSql, row: RunRow): Promise<RunRow> {
  if (row.status !== 'active') return row;
  if (row.play_state === 'cancelled') return markCancelled(tx, row);
  if (row.question_expired && row.question_deadline_at) {
    const question = row.questions[row.cleared_zones];
    return settleRun(tx, row, {
      status: 'lost',
      reason: 'question_timeout',
      score: 0,
      at: new Date(row.question_deadline_at.getTime() - PARTNER_ANSWER_GRACE_MS),
      lastAnswer: { question_id: question.question_id, option_id: null, correct_option_id: question.correct_option_id, outcome: 'late' },
    });
  }
  if (row.decision_expired && row.decision_deadline_at) {
    return settleRun(tx, row, {
      status: 'cashed',
      reason: 'decision_timeout',
      score: partnerRoadToGoalPoints(row.cleared_zones),
      at: row.decision_deadline_at,
    });
  }
  return row;
}

async function recentQuestionIds(tx: TransactionSql, playerId: string): Promise<string[]> {
  const rows = await asSql(tx)<{ id: string }[]>`
    SELECT DISTINCT unnest(question_ids) AS id FROM (
      SELECT question_ids FROM partner_rtg_runs WHERE player_id = ${playerId} ORDER BY created_at DESC LIMIT ${RECENT_RUNS_EXCLUDED}
    ) recent`;
  return rows.map((r) => r.id);
}

/** The site's selection (published, ranked-eligible MCQ, 4×easy, 4×medium, 3×hard), without the RTP calibration. */
async function dealQuestions(tx: TransactionSql, userId: string, playerId: string): Promise<StoredQuestion[]> {
  const recent = await recentQuestionIds(tx, playerId);
  for (const initialExclusions of recent.length > 0 ? [recent, []] : [[]]) {
    const excluded = new Set<string>(initialExclusions);
    const candidates: RoadToGoalQuestionCandidate[] = [];
    for (let page = 0; page < ROAD_TO_GOAL_UNSEEN_MAX_CANDIDATE_PAGES; page += 1) {
      const picked = await roadToGoalRepo.pickRunQuestionCandidates(
        tx, userId, 'unseen', [...excluded], ROAD_TO_GOAL_CANDIDATES_PER_DIFFICULTY);
      if (picked.length === 0) break;
      picked.forEach((c) => excluded.add(c.id));
      candidates.push(...picked);
      const set = buildRoadToGoalQuestionSet(candidates, Math.random, 'unseen');
      if (set) {
        return set.map((q) => ({
          question_id: q.question_id,
          difficulty: q.difficulty,
          prompt: q.prompt,
          ...(q.image ? { image: q.image } : {}),
          options: q.options,
          correct_option_id: q.correct_option_id,
        }));
      }
    }
  }
  logger.error({ playerId }, 'partner road-to-goal: not enough eligible questions');
  throw new PartnerError('maintenance', 'No questions available right now', 30);
}

async function activeRunId(playerId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM partner_rtg_runs WHERE player_id = ${playerId} AND status = 'active'`;
  return row?.id ?? null;
}

/** Runs `fn` on the locked run in one transaction and wakes the score sender if it settled the play. */
async function withRun<T>(
  partner: PartnerPrincipal,
  runId: string,
  fn: (tx: TransactionSql, row: RunRow) => Promise<{ value: T; settled: boolean }>,
): Promise<T> {
  const { value, settled } = await partnerBegin(async (tx) => {
    await lockPlayerFirst(tx, partner.playerId);
    const row = await lockRun(tx, partner.playerId, runId);
    if (!row) throw new PartnerError('not_found', 'Run not found');
    // A play cancelled by a block is closed before anything else; the move below then sees a settled run.
    const open = row.status === 'active' && row.play_state === 'cancelled' ? await markCancelled(tx, row) : row;
    return fn(tx, open);
  }) as { value: T; settled: boolean };
  if (settled) afterPartnerSettle();
  return value;
}

export const partnerRoadToGoalService = {
  /**
   * Starts today's run (reserving the play in the same transaction), or returns the player's open run: a second tab
   * or a retried start resumes instead of spending another play. `startId` makes a retried start idempotent.
   */
  async start(partner: PartnerPrincipal, startId: string): Promise<PartnerRoadToGoalState> {
    const runId = await startPartnerRun(partner, PARTNER_RTG_GAME_ID, startId, {
      async resumeOpen(tx) {
        const [open] = await asSql(tx)<{ id: string }[]>`
          SELECT id FROM partner_rtg_runs WHERE player_id = ${partner.playerId} AND status = 'active'`;
        if (!open) return { runId: null, settled: false };
        const row = (await lockRun(tx, partner.playerId, open.id))!;
        // An open run whose deadline passed is settled here; the player then starts a new one if plays are left.
        const resolved = await resolveExpired(tx, row);
        if (resolved.status === 'active') return { runId: row.id, settled: false };
        return { runId: null, settled: resolved.status !== 'cancelled' };
      },
      async create(tx, play) {
        const db = asSql(tx);
        const questions = await dealQuestions(tx, partner.userId, partner.playerId);
        const [run] = await db<{ id: string }[]>`
          INSERT INTO partner_rtg_runs (play_id, player_id, questions, question_ids, question_deadline_at)
          VALUES (${play.id}, ${partner.playerId}, ${db.json(questions as never)},
                  ${questions.map((q) => q.question_id)}::uuid[],
                  clock_timestamp() + make_interval(secs => ${SERVER_WINDOW_SECONDS}))
          RETURNING id`;
        return run.id;
      },
    });
    return this.get(partner, runId);
  },

  /** The open run, or not_found. A run this read settles (its deadline passed while the player was away) comes back
   *  settled, so the screen shows its result instead of an intro whose Start would find no plays left. */
  async current(partner: PartnerPrincipal): Promise<PartnerRoadToGoalState> {
    const id = await activeRunId(partner.playerId);
    if (!id) throw new PartnerError('not_found', 'No open run');
    return this.get(partner, id);
  },

  async get(partner: PartnerPrincipal, runId: string): Promise<PartnerRoadToGoalState> {
    return withRun(partner, runId, async (tx, row) => {
      const resolved = await resolveExpired(tx, row);
      return { value: toPublicState(resolved), settled: resolved !== row };
    });
  },

  async answer(
    partner: PartnerPrincipal,
    runId: string,
    input: { questionId: string; optionId: string; expectedVersion: number },
  ): Promise<PartnerRoadToGoalAnswerResult> {
    return withRun<PartnerRoadToGoalAnswerResult>(partner, runId, async (tx, row) => {
      if (row.status !== 'active') throw new PartnerError('play_not_active');
      if (row.phase !== 'question') throw new PartnerError('stale_version', 'No question is open');
      const question = row.questions[row.cleared_zones];
      if (question.question_id !== input.questionId) throw new PartnerError('stale_version', 'The answer is for another question');
      assertVersion(row, input.expectedVersion);

      if (row.question_expired) {
        const settled = await resolveExpired(tx, row);
        return { value: { outcome: 'late', correct_option_id: question.correct_option_id, state: toPublicState(settled) }, settled: true };
      }
      const correct = input.optionId === question.correct_option_id;
      const lastAnswer: LastAnswer = {
        question_id: question.question_id,
        option_id: input.optionId,
        correct_option_id: question.correct_option_id,
        outcome: correct ? 'correct' : 'wrong',
      };
      if (!correct) {
        const settled = await settleRun(tx, row, { status: 'lost', reason: 'wrong_answer', score: 0, lastAnswer });
        return { value: { outcome: 'wrong', correct_option_id: question.correct_option_id, state: toPublicState(settled) }, settled: true };
      }
      const cleared = row.cleared_zones + 1;
      if (cleared >= ROAD_TO_GOAL_ZONES) {
        const db = asSql(tx);
        await db`UPDATE partner_rtg_runs SET cleared_zones = ${cleared} WHERE id = ${row.id}`;
        const settled = await settleRun(tx, { ...row, cleared_zones: cleared }, {
          status: 'completed', reason: 'completed', score: partnerRoadToGoalPoints(cleared), lastAnswer,
        });
        return { value: { outcome: 'correct', correct_option_id: question.correct_option_id, state: toPublicState(settled) }, settled: true };
      }
      const db = asSql(tx);
      await db`
        UPDATE partner_rtg_runs
        SET cleared_zones = ${cleared}, phase = 'decision', question_deadline_at = NULL,
            decision_deadline_at = clock_timestamp() + make_interval(secs => ${ROAD_TO_GOAL_DECISION_MS / 1000}),
            last_answer = ${db.json(lastAnswer as never)}, state_version = state_version + 1, updated_at = clock_timestamp()
        WHERE id = ${row.id}`;
      const next = await relock(tx, row);
      return { value: { outcome: 'correct', correct_option_id: question.correct_option_id, state: toPublicState(next) }, settled: false };
    });
  },

  /** Deals the next zone's question. A decision that already timed out was a cash-out. */
  async continueRun(partner: PartnerPrincipal, runId: string, expectedVersion: number): Promise<PartnerRoadToGoalState> {
    return withRun(partner, runId, async (tx, row) => {
      if (row.status !== 'active') throw new PartnerError('play_not_active');
      if (row.phase !== 'decision') throw new PartnerError('stale_version', 'Nothing to continue');
      assertVersion(row, expectedVersion);
      if (row.decision_expired) {
        const settled = await resolveExpired(tx, row);
        return { value: toPublicState(settled), settled: true };
      }
      await asSql(tx)`
        UPDATE partner_rtg_runs
        SET phase = 'question', decision_deadline_at = NULL, last_answer = NULL,
            question_deadline_at = clock_timestamp() + make_interval(secs => ${SERVER_WINDOW_SECONDS}),
            state_version = state_version + 1, updated_at = clock_timestamp()
        WHERE id = ${row.id}`;
      return { value: toPublicState(await relock(tx, row)), settled: false };
    });
  },

  /** Cash-out exists only at the decision after a cleared zone. */
  async cashout(partner: PartnerPrincipal, runId: string, expectedVersion: number): Promise<PartnerRoadToGoalState> {
    return withRun(partner, runId, async (tx, row) => {
      if (row.status !== 'active') throw new PartnerError('play_not_active');
      if (row.phase !== 'decision') throw new PartnerError('stale_version', 'Cash-out is possible only after a cleared zone');
      assertVersion(row, expectedVersion);
      const settled = row.decision_expired
        ? await resolveExpired(tx, row)
        : await settleRun(tx, row, { status: 'cashed', reason: 'cashout', score: partnerRoadToGoalPoints(row.cleared_zones) });
      return { value: toPublicState(settled), settled: true };
    });
  },

  /** The player closed the game: during a question that is 0, at the decision a cash-out. */
  async leave(partner: PartnerPrincipal, runId: string): Promise<PartnerRoadToGoalState> {
    return withRun(partner, runId, async (tx, row) => {
      if (row.status !== 'active') return { value: toPublicState(row), settled: false };
      const expired = await resolveExpired(tx, row);
      if (expired !== row) return { value: toPublicState(expired), settled: true };
      const settled = row.phase === 'question'
        ? await settleRun(tx, row, {
            status: 'lost',
            reason: 'left_question',
            score: 0,
            lastAnswer: (() => {
              const q = row.questions[row.cleared_zones];
              return { question_id: q.question_id, option_id: null, correct_option_id: q.correct_option_id, outcome: 'late' as const };
            })(),
          })
        : await settleRun(tx, row, { status: 'cashed', reason: 'left_decision', score: partnerRoadToGoalPoints(row.cleared_zones) });
      return { value: toPublicState(settled), settled: true };
    });
  },

  /** Settles every open run whose deadline has passed (players who closed the game). */
  async sweep(): Promise<{ settled: number }> {
    const due = await sql<{ id: string; player_id: string }[]>`
      SELECT id, player_id FROM partner_rtg_runs
      WHERE status = 'active' AND LEAST(question_deadline_at, decision_deadline_at) <= clock_timestamp()
      ORDER BY LEAST(question_deadline_at, decision_deadline_at)
      LIMIT ${SWEEP_BATCH}`;
    let settled = 0;
    for (const run of due) {
      try {
        const done = await partnerBegin(async (tx) => {
          await lockPlayerFirst(tx, run.player_id);
          const row = await lockRun(tx, run.player_id, run.id, true);
          if (!row || row.status !== 'active') return false;
          return (await resolveExpired(tx, row)) !== row;
        });
        if (done) settled += 1;
      } catch (error) {
        logger.error({ err: error, runId: run.id }, 'partner road-to-goal sweep failed for run');
      }
    }
    if (settled > 0) afterPartnerSettle();
    return { settled };
  },
};
