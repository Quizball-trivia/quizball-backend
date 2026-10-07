/** Freecroco Trivia Mines (contract §7.6): the site's board as a free skill game. 25 tiles hide 4 defenders; the value
 *  starts at 100 and each safe tile multiplies the fair value by the site's step (unknown ÷ (unknown − hidden
 *  defenders)). Up to 3 scouting questions: a right answer flags a defender, a wrong or late one just uses the scout.
 *  Cash-out while picking after ≥1 safe tile scores floor(value × 0.97), at most 1,000; a defender scores 0. Leaving
 *  after a safe tile cashes out, leaving before one scores 0, and leaving before any tile or scout returns the play. */

import { sql, type TransactionSql } from '../../../../db/index.js';
import { partnerBegin } from '../../partner-analytics.js';
import type { I18nField } from '../../../../db/types.js';
import { logger } from '../../../../core/logger.js';
import { asSql } from '../../partner-db.js';
import { PartnerError } from '../../partner-errors.js';
import type { PartnerPrincipal } from '../../partner-player-auth.js';
import { cancelPlay } from '../../partner-quota.service.js';
import { afterPartnerSettle, settlePartnerPlay } from '../kit.js';
import { lockPlayerFirst, startPartnerRun } from '../road-to-goal/partner-start.js';
import {
  BOARD_SIZE,
  DEFENDERS,
  MAX_SAFE_PICKS,
  MILLI,
  SCOUTS_PER_ROUND,
  STALE_AFTER_MS,
  cashoutValue,
  fairPotAfterPick,
} from '../../../trivia-mines/trivia-mines.constants.js';
import { boardHmacInput, defendersFromSeed, newServerSeed, scoutRevealFromSeed } from '../../../trivia-mines/trivia-mines.fairness.js';
import { triviaMinesRepo } from '../../../trivia-mines/trivia-mines.repo.js';

export const PARTNER_MINES_GAME_ID = 'trivia-mines' as const;
export const PARTNER_MINES_START_POINTS = 100;
export const PARTNER_MINES_MAX_POINTS = 1_000;
/** The site's visible scouting clock (its server window adds a 2 s grace). */
export const PARTNER_MINES_QUESTION_MS = 10_000;
/** Contract §7: an answer reaching us up to 1 s after the visible deadline still counts. */
export const PARTNER_ANSWER_GRACE_MS = 1_000;
const RECENT_RUNS_EXCLUDED = 30;
const SWEEP_BATCH = 50;

type RunStatus = 'active' | 'cashed' | 'lost' | 'cancelled';
type RunPhase = 'picking' | 'question' | 'settled';
type SettlementReason =
  | 'cashout'
  | 'auto_cashout'
  | 'defender'
  | 'left_cashout'
  | 'left_before_safe_tile'
  | 'left_unused'
  | 'play_cancelled';

interface QuestionSnapshot {
  question_id: string;
  prompt: I18nField;
  options: Array<{ id: string; text: I18nField }>;
}

interface RunRow {
  id: string;
  play_id: string;
  player_id: string;
  status: RunStatus;
  phase: RunPhase;
  state_version: number;
  pot_milli: string | number;
  opened: number[];
  flagged: number[];
  bust_tile: number | null;
  scouts_left: number;
  question_id: string | null;
  question_payload: QuestionSnapshot | null;
  question_correct_option: string | null;
  question_deadline_at: Date | null;
  server_seed: string;
  score: number | null;
  settlement_reason: SettlementReason | null;
  last_seen_at: Date;
  db_now: Date;
  question_expired: boolean;
  /** No heartbeat or request for STALE_AFTER_MS: the player left. */
  stale: boolean;
  play_state: 'started' | 'finished' | 'cancelled';
}

export interface PartnerTriviaMinesState {
  run_id: string;
  play_id: string;
  status: RunStatus;
  phase: RunPhase;
  state_version: number;
  start_points: number;
  max_points: number;
  /** What a cash-out would score now (the start value before the first safe tile). */
  points: number;
  /** What a cash-out would score after one more safe tile. */
  next_points: number;
  mult_bp: number;
  opened: number[];
  flagged: number[];
  bust_tile: number | null;
  scouts_left: number;
  board_size: number;
  defender_count: number;
  question: { question_id: string; prompt: I18nField; options: Array<{ id: string; text: I18nField }>; deadline_at: string } | null;
  score: number | null;
  settlement_reason: SettlementReason | null;
  /** Every defender, once the run is over. */
  reveal: { defenders: number[] } | null;
  server_now: string;
}

/** Score of a cash-out from a fair value: the site's 0.97 margin and rounding, capped for Freecroco. */
export function partnerMinesCashoutPoints(fairPotMilli: number): number {
  return Math.min(PARTNER_MINES_MAX_POINTS, cashoutValue(fairPotMilli));
}

const defendersOf = (row: Pick<RunRow, 'id' | 'server_seed'>) => defendersFromSeed(row.server_seed, boardHmacInput(row.id, null));
const potOf = (row: RunRow) => Number(row.pot_milli);
const unknownTiles = (row: RunRow) => BOARD_SIZE - row.opened.length - row.flagged.length;
const hiddenDefenders = (row: RunRow) => DEFENDERS - row.flagged.length;
/** The play counts as used once a tile was opened or a scouting question was shown. */
const playUsed = (row: RunRow) => row.opened.length > 0 || row.scouts_left < SCOUTS_PER_ROUND || row.phase === 'question';

function toPublicState(row: RunRow): PartnerTriviaMinesState {
  const active = row.status === 'active';
  const points = active
    ? row.opened.length > 0 ? partnerMinesCashoutPoints(potOf(row)) : PARTNER_MINES_START_POINTS
    : row.score ?? 0;
  const nextPoints = active && row.opened.length < MAX_SAFE_PICKS && hiddenDefenders(row) < unknownTiles(row)
    ? partnerMinesCashoutPoints(fairPotAfterPick(potOf(row), unknownTiles(row), hiddenDefenders(row)))
    : points;
  return {
    run_id: row.id,
    play_id: row.play_id,
    status: row.status,
    phase: row.phase,
    state_version: row.state_version,
    start_points: PARTNER_MINES_START_POINTS,
    max_points: PARTNER_MINES_MAX_POINTS,
    points,
    next_points: nextPoints,
    mult_bp: Math.round((points * 10_000) / PARTNER_MINES_START_POINTS),
    opened: row.opened,
    flagged: row.flagged,
    bust_tile: row.bust_tile,
    scouts_left: row.scouts_left,
    board_size: BOARD_SIZE,
    defender_count: DEFENDERS,
    question: active && row.phase === 'question' && row.question_payload && row.question_deadline_at
      // The stored deadline includes the grace; the player sees the visible one.
      ? { ...row.question_payload, deadline_at: new Date(row.question_deadline_at.getTime() - PARTNER_ANSWER_GRACE_MS).toISOString() }
      : null,
    score: row.score,
    settlement_reason: row.settlement_reason,
    reveal: active ? null : { defenders: defendersOf(row) },
    server_now: row.db_now.toISOString(),
  };
}

const STALE_SECONDS = STALE_AFTER_MS / 1000;

const RUN_COLUMNS = (db: ReturnType<typeof asSql>) => db`
  r.*, p.state AS play_state, clock_timestamp() AS db_now,
  (r.phase = 'question' AND r.question_deadline_at <= clock_timestamp()) AS question_expired,
  (r.last_seen_at < clock_timestamp() - make_interval(secs => ${STALE_SECONDS})) AS stale`;

async function lockRun(tx: TransactionSql, playerId: string, runId: string, skipLocked = false): Promise<RunRow | null> {
  const db = asSql(tx);
  const [row] = await db<RunRow[]>`
    SELECT ${RUN_COLUMNS(db)} FROM partner_mines_runs r JOIN partner_plays p ON p.id = r.play_id
    WHERE r.id = ${runId} AND r.player_id = ${playerId}
    FOR UPDATE OF r ${skipLocked ? db`SKIP LOCKED` : db``}`;
  return row ?? null;
}

async function relock(tx: TransactionSql, row: RunRow): Promise<RunRow> {
  return (await lockRun(tx, row.player_id, row.id))!;
}

async function update(tx: TransactionSql, row: RunRow, patch: Record<string, unknown>): Promise<RunRow> {
  const db = asSql(tx);
  await db`
    UPDATE partner_mines_runs
    SET ${db(patch as Record<string, never>)}, state_version = state_version + 1, last_seen_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE id = ${row.id}`;
  return relock(tx, row);
}

const clearQuestion = { question_id: null, question_payload: null, question_correct_option: null, question_deadline_at: null };

/** An unanswered scout burns when its time is up; the board is untouched. */
async function resolveExpiredQuestion(tx: TransactionSql, row: RunRow): Promise<RunRow> {
  if (row.status !== 'active' || !row.question_expired) return row;
  return update(tx, row, { phase: 'picking', scouts_left: Math.max(0, row.scouts_left - 1), ...clearQuestion });
}

async function settle(
  tx: TransactionSql,
  row: RunRow,
  input: { status: 'cashed' | 'lost'; reason: SettlementReason; score: number; at?: Date; bustTile?: number },
): Promise<RunRow> {
  const settled = await update(tx, row, {
    status: input.status,
    phase: 'settled',
    score: input.score,
    settlement_reason: input.reason,
    bust_tile: input.bustTile ?? row.bust_tile,
    settled_at: input.at ?? row.db_now,
    ...clearQuestion,
  });
  const play = await settlePartnerPlay(tx, row.play_id, input.score, input.at, undefined, { endCause: input.reason });
  // A block cancelled the play meanwhile: no event, so the run shows no points either.
  if (play.state === 'cancelled') return markCancelled(tx, settled);
  return settled;
}

async function markCancelled(tx: TransactionSql, row: RunRow): Promise<RunRow> {
  const db = asSql(tx);
  await db`
    UPDATE partner_mines_runs
    SET status = 'cancelled', phase = 'settled', score = NULL, settlement_reason = 'play_cancelled',
        settled_at = COALESCE(settled_at, clock_timestamp()), state_version = state_version + 1, updated_at = clock_timestamp(),
        question_id = NULL, question_payload = NULL, question_correct_option = NULL, question_deadline_at = NULL
    WHERE id = ${row.id}`;
  return relock(tx, row);
}

/** Leaving (explicit, or silent past the heartbeat window): cash-out after a safe tile, 0 if only a scout was used,
 *  and the play returned when nothing was touched. */
async function settleLeaver(tx: TransactionSql, row: RunRow, at?: Date): Promise<{ row: RunRow; settled: boolean }> {
  if (row.opened.length > 0) {
    return { row: await settle(tx, row, { status: 'cashed', reason: 'left_cashout', score: partnerMinesCashoutPoints(potOf(row)), at }), settled: true };
  }
  if (playUsed(row)) {
    return { row: await settle(tx, row, { status: 'lost', reason: 'left_before_safe_tile', score: 0, at }), settled: true };
  }
  const cancelled = await update(tx, row, {
    status: 'cancelled', phase: 'settled', score: null, settlement_reason: 'left_unused', settled_at: at ?? row.db_now, ...clearQuestion,
  });
  await cancelPlay(tx, row.play_id, { refund: true });
  return { row: cancelled, settled: false };
}

async function activeRunId(playerId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM partner_mines_runs WHERE player_id = ${playerId} AND status = 'active'`;
  return row?.id ?? null;
}

/**
 * Ends a run whose play is over before anything else touches it: a play cancelled by a block, or a player silent for
 * the heartbeat window (settled as a leave at the moment the window ran out, whether or not the sweeper got there
 * first). Returns the row unchanged when the run goes on.
 */
async function closeIfOver(tx: TransactionSql, row: RunRow): Promise<{ row: RunRow; settled: boolean }> {
  if (row.status !== 'active') return { row, settled: false };
  if (row.play_state === 'cancelled') return { row: await markCancelled(tx, row), settled: false };
  if (row.stale) return settleLeaver(tx, row, new Date(row.last_seen_at.getTime() + STALE_AFTER_MS));
  return { row, settled: false };
}

/**
 * Runs `fn` on the locked, still-open run in one transaction. A run that turned out to be over is closed and committed
 * first: a read then returns it, a move gets play_not_active (the client re-reads the settled run).
 */
async function withRun<T>(
  partner: PartnerPrincipal,
  runId: string,
  mode: 'read' | 'move',
  fn: (tx: TransactionSql, row: RunRow) => Promise<{ value: T; settled: boolean }>,
): Promise<T> {
  type Outcome = { value: T; settled: boolean; closed: false } | { value: PartnerTriviaMinesState; settled: boolean; closed: true };
  const outcome = await partnerBegin(async (tx): Promise<Outcome> => {
    await lockPlayerFirst(tx, partner.playerId);
    const locked = await lockRun(tx, partner.playerId, runId);
    if (!locked) throw new PartnerError('not_found', 'Run not found');
    const over = await closeIfOver(tx, locked);
    if (over.row !== locked) return { value: toPublicState(over.row), settled: over.settled, closed: true };
    return { ...(await fn(tx, locked)), closed: false };
  }) as Outcome;
  if (outcome.settled) afterPartnerSettle();
  if (outcome.closed && mode === 'move') throw new PartnerError('play_not_active');
  return outcome.value as T;
}

function assertActive(row: RunRow): void {
  if (row.status !== 'active') throw new PartnerError('play_not_active');
}

function assertVersion(row: RunRow, expectedVersion: number): void {
  if (row.state_version !== expectedVersion) throw new PartnerError('stale_version', 'The run changed; reload it');
}

function parseOptions(payload: unknown): Array<{ id: string; text: I18nField; is_correct: boolean }> | null {
  const parsed = typeof payload === 'string' ? (() => { try { return JSON.parse(payload) as unknown; } catch { return null; } })() : payload;
  const options = (parsed as { options?: unknown } | null)?.options;
  if (!Array.isArray(options) || options.length !== 4) return null;
  for (const o of options as Array<Record<string, unknown>>) {
    if (typeof o.id !== 'string' || o.text == null || typeof o.is_correct !== 'boolean') return null;
  }
  const typed = options as Array<{ id: string; text: I18nField; is_correct: boolean }>;
  return typed.filter((o) => o.is_correct).length === 1 ? typed : null;
}

function shuffled<T>(values: T[]): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Chosen before the run is locked: the selection needs no lock and must not take a second pool connection inside a
 *  transaction. */
async function pickScoutQuestion(playerId: string): Promise<{ snapshot: QuestionSnapshot; correct: string }> {
  const recent = await sql<{ id: string }[]>`
    SELECT DISTINCT unnest(question_ids) AS id FROM (
      SELECT question_ids FROM partner_mines_runs WHERE player_id = ${playerId} ORDER BY created_at DESC LIMIT ${RECENT_RUNS_EXCLUDED}
    ) recent`;
  for (const exclude of [recent.map((r) => r.id), []]) {
    for (const candidate of await triviaMinesRepo.pickQuestionCandidates(exclude)) {
      const options = parseOptions(candidate.payload);
      const prompt = typeof candidate.prompt === 'string'
        ? (() => { try { return JSON.parse(candidate.prompt) as I18nField; } catch { return null; } })()
        : (candidate.prompt as unknown as I18nField);
      if (!options || !prompt) continue;
      const order = shuffled(options);
      return {
        snapshot: { question_id: candidate.id, prompt, options: order.map(({ id, text }) => ({ id, text })) },
        correct: order.find((o) => o.is_correct)!.id,
      };
    }
  }
  logger.error({ playerId }, 'partner trivia-mines: no eligible scouting question');
  throw new PartnerError('maintenance', 'No questions available right now', 30);
}

export const partnerTriviaMinesService = {
  /** Starts today's run (the play is reserved now, returned if the player leaves before touching the board), or
   *  resumes the open one with the same committed board. `startId` makes a retried start idempotent. */
  async start(partner: PartnerPrincipal, startId: string): Promise<PartnerTriviaMinesState> {
    const runId = await startPartnerRun(partner, PARTNER_MINES_GAME_ID, startId, {
      async resumeOpen(tx) {
        const [open] = await asSql(tx)<{ id: string }[]>`
          SELECT id FROM partner_mines_runs WHERE player_id = ${partner.playerId} AND status = 'active'`;
        if (!open) return { runId: null, settled: false };
        const row = (await lockRun(tx, partner.playerId, open.id))!;
        const over = await closeIfOver(tx, row);
        if (over.row === row) return { runId: row.id, settled: false };
        return { runId: null, settled: over.settled };
      },
      async create(tx, play) {
        const [run] = await asSql(tx)<{ id: string }[]>`
          INSERT INTO partner_mines_runs (play_id, player_id, pot_milli, server_seed)
          VALUES (${play.id}, ${partner.playerId}, ${PARTNER_MINES_START_POINTS * MILLI}, ${newServerSeed()})
          RETURNING id`;
        return run.id;
      },
    });
    return this.get(partner, runId);
  },

  async current(partner: PartnerPrincipal): Promise<PartnerTriviaMinesState> {
    const id = await activeRunId(partner.playerId);
    if (!id) throw new PartnerError('not_found', 'No open run');
    return this.get(partner, id);
  },

  /** The player's most recent run in any state (a run the sweeper settled while the player was away). */
  async latest(partner: PartnerPrincipal): Promise<PartnerTriviaMinesState> {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM partner_mines_runs WHERE player_id = ${partner.playerId} ORDER BY created_at DESC LIMIT 1`;
    if (!row) throw new PartnerError('not_found', 'No runs yet');
    return this.get(partner, row.id);
  },

  /** A read is the player's own client: it counts as seen, so a resumed board is never swept under the player. */
  async get(partner: PartnerPrincipal, runId: string): Promise<PartnerTriviaMinesState> {
    return withRun(partner, runId, 'read', async (tx, row) => {
      if (row.status !== 'active') return { value: toPublicState(row), settled: false };
      await asSql(tx)`UPDATE partner_mines_runs SET last_seen_at = clock_timestamp() WHERE id = ${row.id}`;
      return { value: toPublicState(await resolveExpiredQuestion(tx, await relock(tx, row))), settled: false };
    });
  },

  async pick(partner: PartnerPrincipal, runId: string, input: { tile: number; expectedVersion: number }): Promise<{ safe: boolean; state: PartnerTriviaMinesState }> {
    return withRun<{ safe: boolean; state: PartnerTriviaMinesState }>(partner, runId, 'move', async (tx, row) => {
      assertActive(row);
      if (row.phase !== 'picking') throw new PartnerError('stale_version', 'Answer the scouting question first');
      assertVersion(row, input.expectedVersion);
      if (!Number.isInteger(input.tile) || input.tile < 0 || input.tile >= BOARD_SIZE) throw new PartnerError('invalid_request', 'tile: out of range');
      if (row.opened.includes(input.tile) || row.flagged.includes(input.tile)) throw new PartnerError('invalid_request', 'tile: already open');

      if (defendersOf(row).includes(input.tile)) {
        const lost = await settle(tx, row, { status: 'lost', reason: 'defender', score: 0, bustTile: input.tile });
        return { value: { safe: false, state: toPublicState(lost) }, settled: true };
      }
      const picked = await update(tx, row, {
        opened: [...row.opened, input.tile],
        pot_milli: fairPotAfterPick(potOf(row), unknownTiles(row), hiddenDefenders(row)),
      });
      // Every safe tile opened: nothing is left to risk, so it banks.
      if (picked.opened.length >= MAX_SAFE_PICKS) {
        const banked = await settle(tx, picked, { status: 'cashed', reason: 'auto_cashout', score: partnerMinesCashoutPoints(potOf(picked)) });
        return { value: { safe: true, state: toPublicState(banked) }, settled: true };
      }
      return { value: { safe: true, state: toPublicState(picked) }, settled: false };
    });
  },

  /** Shows a scouting question (this uses the play). The correct option stays on the server. */
  async deal(partner: PartnerPrincipal, runId: string, expectedVersion: number): Promise<PartnerTriviaMinesState> {
    const { snapshot, correct } = await pickScoutQuestion(partner.playerId);
    return withRun(partner, runId, 'move', async (tx, row) => {
      assertActive(row);
      if (row.phase !== 'picking') throw new PartnerError('stale_version', 'A scouting question is already open');
      assertVersion(row, expectedVersion);
      if (row.scouts_left <= 0) throw new PartnerError('invalid_request', 'No scouting questions left');
      if (row.flagged.length >= DEFENDERS) throw new PartnerError('invalid_request', 'Every defender is already flagged');
      const db = asSql(tx);
      await db`
        UPDATE partner_mines_runs
        SET phase = 'question', question_id = ${snapshot.question_id}, question_payload = ${db.json(snapshot as never)},
            question_correct_option = ${correct},
            question_deadline_at = clock_timestamp() + make_interval(secs => ${(PARTNER_MINES_QUESTION_MS + PARTNER_ANSWER_GRACE_MS) / 1000}),
            question_ids = array_append(question_ids, ${snapshot.question_id}::uuid),
            state_version = state_version + 1, last_seen_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${row.id}`;
      return { value: toPublicState(await relock(tx, row)), settled: false };
    });
  },

  async answer(
    partner: PartnerPrincipal,
    runId: string,
    input: { questionId: string; optionId: string; expectedVersion: number },
  ): Promise<{ outcome: 'correct' | 'wrong' | 'late'; correct_option_id: string; flagged_tile: number | null; state: PartnerTriviaMinesState }> {
    return withRun(partner, runId, 'move', async (tx, row) => {
      assertActive(row);
      if (row.phase !== 'question' || !row.question_id || !row.question_correct_option) throw new PartnerError('stale_version', 'No scouting question is open');
      if (row.question_id !== input.questionId) throw new PartnerError('stale_version', 'The answer is for another question');
      assertVersion(row, input.expectedVersion);
      const correctOption = row.question_correct_option;
      const late = row.question_expired;
      const correct = !late && input.optionId === correctOption;
      let flaggedTile: number | null = null;
      if (correct) {
        const hidden = defendersOf(row).filter((tile) => !row.flagged.includes(tile));
        const scoutNumber = SCOUTS_PER_ROUND - row.scouts_left;
        if (hidden.length > 0) flaggedTile = scoutRevealFromSeed(row.server_seed, boardHmacInput(row.id, null), scoutNumber, hidden);
      }
      const next = await update(tx, row, {
        phase: 'picking',
        scouts_left: row.scouts_left - 1,
        flagged: flaggedTile == null ? row.flagged : [...row.flagged, flaggedTile],
        ...clearQuestion,
      });
      return {
        value: { outcome: late ? 'late' : correct ? 'correct' : 'wrong', correct_option_id: correctOption, flagged_tile: flaggedTile, state: toPublicState(next) },
        settled: false,
      };
    });
  },

  async cashout(partner: PartnerPrincipal, runId: string, expectedVersion: number): Promise<PartnerTriviaMinesState> {
    return withRun(partner, runId, 'move', async (tx, row) => {
      assertActive(row);
      if (row.phase !== 'picking') throw new PartnerError('stale_version', 'Answer the scouting question first');
      assertVersion(row, expectedVersion);
      if (row.opened.length === 0) throw new PartnerError('invalid_request', 'Open a safe tile before cashing out');
      const banked = await settle(tx, row, { status: 'cashed', reason: 'cashout', score: partnerMinesCashoutPoints(potOf(row)) });
      return { value: toPublicState(banked), settled: true };
    });
  },

  async heartbeat(partner: PartnerPrincipal): Promise<void> {
    // A run already past its window stays stale: the next request settles it as a leave.
    await sql`
      UPDATE partner_mines_runs SET last_seen_at = clock_timestamp()
      WHERE player_id = ${partner.playerId} AND status = 'active'
        AND last_seen_at >= clock_timestamp() - make_interval(secs => ${STALE_SECONDS})`;
  },

  async leave(partner: PartnerPrincipal, runId: string): Promise<PartnerTriviaMinesState> {
    return withRun(partner, runId, 'read', async (tx, row) => {
      if (row.status !== 'active') return { value: toPublicState(row), settled: false };
      const result = await settleLeaver(tx, row);
      return { value: toPublicState(result.row), settled: result.settled };
    });
  },

  /** Runs without a heartbeat for STALE_AFTER_MS were left: settled as a leave at the moment the window ran out. */
  async sweep(): Promise<{ settled: number }> {
    const due = await sql<{ id: string; player_id: string }[]>`
      SELECT id, player_id FROM partner_mines_runs
      WHERE status = 'active' AND last_seen_at < clock_timestamp() - make_interval(secs => ${STALE_SECONDS})
      ORDER BY last_seen_at LIMIT ${SWEEP_BATCH}`;
    let settled = 0;
    for (const run of due) {
      try {
        const done = await partnerBegin(async (tx) => {
          await lockPlayerFirst(tx, run.player_id);
          const row = await lockRun(tx, run.player_id, run.id, true);
          if (!row) return false;
          return (await closeIfOver(tx, row)).row !== row;
        });
        if (done) settled += 1;
      } catch (error) {
        logger.error({ err: error, runId: run.id }, 'partner trivia-mines sweep failed for run');
      }
    }
    if (settled > 0) afterPartnerSettle();
    return { settled };
  },
};
