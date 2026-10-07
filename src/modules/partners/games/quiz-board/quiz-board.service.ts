/** Quiz Board plays: storage, the player's view, settlement and the sweeper. The rules live in
 *  quiz-board.machine.ts; every move locks the board row, first applies any deadline that has passed, then the move,
 *  and settles the partner play in the same transaction when the board finishes. */

import { randomBytes } from 'node:crypto';
import { sql, type TransactionSql } from '../../../../db/index.js';
import { partnerBegin } from '../../partner-analytics.js';
import { logger } from '../../../../core/logger.js';
import { asSql } from '../../partner-db.js';
import { PartnerError } from '../../partner-errors.js';
import type { PartnerPrincipal } from '../../partner-player-auth.js';
import { afterPartnerSettle, settlePartnerPlay } from '../kit.js';
import { reservePlay } from '../../partner-quota.service.js';
import { drawBoard, type I18nText, type QuizBoardImage } from './quiz-board.content.js';
import {
  advance,
  answerTile,
  cancelBoard,
  GRACE_MS,
  initialState,
  leaveBoard,
  pickTile,
  playerScoreOf,
  QUIZ_BOARD_VALUES,
  QuizBoardMoveError,
  seededOptionOrder,
  type QuizBoardDifficulty,
  type QuizBoardEndReason,
  type QuizBoardEvent,
  type QuizBoardEventKind,
  type QuizBoardOwner,
  type QuizBoardPhase,
  type QuizBoardState,
  type QuizBoardTile,
  type Transition,
} from './quiz-board.machine.js';

export const QUIZ_BOARD_GAME_ID = 'quiz-board' as const;

// ---------------------------------------------------------------------------------------------------------------
// The player's view (never carries a right answer before the player has answered that tile)

export interface QuizBoardTileView {
  tile: number;
  category: number;
  row: number;
  value: number;
  owner: QuizBoardOwner | null;
}

export interface QuizBoardQuestionView {
  tile: number;
  value: number;
  prompt: string;
  image: QuizBoardImage | null;
  options: string[];
}

export interface QuizBoardEventView {
  seq: number;
  actor: QuizBoardEvent['actor'];
  kind: QuizBoardEventKind;
  tile: number | null;
  correct: boolean | null;
  choice: number | null;
  points: number;
  /** The player's answered or timed-out tile: its right option. */
  correctIndex?: number;
}

export interface QuizBoardView {
  playId: string;
  phase: QuizBoardPhase;
  turn: number;
  serverNow: string;
  deadlineAt: string | null;
  playerScore: number;
  categories: string[];
  tiles: QuizBoardTileView[];
  /** The tile being answered. */
  activeTile: number | null;
  /** The active tile's question (no right answer). */
  question: QuizBoardQuestionView | null;
  events: QuizBoardEventView[];
  result: { score: number; endReason: QuizBoardEndReason } | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

interface BoardRow {
  id: string;
  play_id: string;
  partner_player_id: string;
  categories: { id: string; name: I18nText }[];
  phase: QuizBoardPhase;
  active_tile: number | null;
  turn: number;
  deadline_at: Date | null;
  player_score: number;
  end_reason: QuizBoardEndReason | null;
  finished_at: Date | null;
  play_state: 'started' | 'finished' | 'cancelled';
}

interface TileRow {
  tile: number;
  difficulty: QuizBoardDifficulty;
  value: number;
  prompt: I18nText;
  options: I18nText[];
  image: QuizBoardImage | null;
  correct_index: number;
  owner: QuizBoardOwner | null;
  used_at: Date | null;
}

interface EventRow {
  seq: number;
  actor: QuizBoardEvent['actor'];
  kind: QuizBoardEventKind;
  tile: number | null;
  correct: boolean | null;
  choice: number | null;
  points: number;
  at: Date;
}

interface LoadedBoard {
  board: BoardRow;
  tiles: TileRow[];
  events: EventRow[];
}

function toState(board: BoardRow, tiles: TileRow[]): QuizBoardState {
  return {
    phase: board.phase,
    activeTile: board.active_tile,
    turn: board.turn,
    deadlineAt: board.deadline_at,
    playerScore: board.player_score,
    endReason: board.end_reason,
    finishedAt: board.finished_at,
    tiles: tiles.map(
      (t): QuizBoardTile => ({
        tile: t.tile,
        difficulty: t.difficulty,
        value: t.value,
        correctIndex: t.correct_index,
        owner: t.owner,
        usedAt: t.used_at,
      }),
    ),
  };
}

export function localized(text: I18nText, language: string): string {
  return text[language] ?? text.en ?? Object.values(text)[0] ?? '';
}

export function buildView(loaded: LoadedBoard, state: QuizBoardState, language: string, now: Date): QuizBoardView {
  const tiles = new Map(loaded.tiles.map((t) => [t.tile, t]));
  const active = state.activeTile !== null ? tiles.get(state.activeTile)! : null;
  return {
    playId: loaded.board.play_id,
    phase: state.phase,
    turn: state.turn,
    serverNow: now.toISOString(),
    deadlineAt: state.deadlineAt?.toISOString() ?? null,
    playerScore: state.playerScore,
    categories: loaded.board.categories.map((c) => localized(c.name, language)),
    tiles: state.tiles.map((t) => ({
      tile: t.tile,
      category: Math.floor(t.tile / 3),
      row: t.tile % 3,
      value: t.value,
      owner: t.owner,
    })),
    activeTile: state.activeTile,
    question: active
      ? {
          tile: active.tile,
          value: active.value,
          prompt: localized(active.prompt, language),
          image: active.image,
          options: active.options.map((o) => localized(o, language)),
        }
      : null,
    events: loaded.events.map((e) => {
      const view: QuizBoardEventView = {
        seq: e.seq,
        actor: e.actor,
        kind: e.kind,
        tile: e.tile,
        correct: e.correct,
        choice: e.choice,
        points: e.points,
      };
      const tile = e.tile !== null ? tiles.get(e.tile) : undefined;
      if (tile && (e.kind === 'answer' || e.kind === 'timeout')) view.correctIndex = tile.correct_index;
      return view;
    }),
    result: state.phase === 'finished' ? { score: state.playerScore, endReason: state.endReason! } : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Storage

type BoardKey = { playId: string } | { openFor: string } | { boardId: string };

async function lockBoard(tx: TransactionSql, key: BoardKey, skipLocked = false): Promise<LoadedBoard | null> {
  const db = asSql(tx);
  const where =
    'playId' in key
      ? db`b.play_id = ${key.playId}`
      : 'openFor' in key
        ? db`b.partner_player_id = ${key.openFor} AND b.phase <> 'finished'`
        : db`b.id = ${key.boardId}`;
  const [board] = skipLocked
    ? await db<BoardRow[]>`
        SELECT b.*, p.state AS play_state FROM partner_quiz_boards b JOIN partner_plays p ON p.id = b.play_id
        WHERE ${where} FOR UPDATE OF b SKIP LOCKED`
    : await db<BoardRow[]>`
        SELECT b.*, p.state AS play_state FROM partner_quiz_boards b JOIN partner_plays p ON p.id = b.play_id
        WHERE ${where} FOR UPDATE OF b`;
  if (!board) return null;
  const tiles = await db<TileRow[]>`
    SELECT tile, difficulty, value, prompt, options, image, correct_index, owner, used_at
    FROM partner_quiz_board_tiles WHERE board_id = ${board.id} ORDER BY tile`;
  const events = await db<EventRow[]>`
    SELECT seq, actor, kind, tile, correct, choice, points, at
    FROM partner_quiz_board_events WHERE board_id = ${board.id} ORDER BY seq`;
  return { board, tiles, events };
}

async function dbNow(tx: TransactionSql): Promise<Date> {
  const [row] = await asSql(tx)<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row.now;
}

async function persist(tx: TransactionSql, loaded: LoadedBoard, before: QuizBoardState, step: Transition): Promise<void> {
  const db = asSql(tx);
  const s = step.state;
  await db`
    UPDATE partner_quiz_boards
    SET phase = ${s.phase}, active_tile = ${s.activeTile}, turn = ${s.turn}, deadline_at = ${s.deadlineAt},
        player_score = ${s.playerScore}, end_reason = ${s.endReason}, finished_at = ${s.finishedAt}, updated_at = clock_timestamp()
    WHERE id = ${loaded.board.id}`;
  for (const tile of s.tiles) {
    const old = before.tiles.find((t) => t.tile === tile.tile)!;
    if (old.owner === tile.owner) continue;
    await db`
      UPDATE partner_quiz_board_tiles SET owner = ${tile.owner}, used_at = ${tile.usedAt}
      WHERE board_id = ${loaded.board.id} AND tile = ${tile.tile}`;
  }
  let seq = loaded.events.length ? loaded.events[loaded.events.length - 1].seq : 0;
  for (const e of step.events) {
    seq += 1;
    const row: EventRow = { seq, ...e };
    await db`
      INSERT INTO partner_quiz_board_events (board_id, seq, actor, kind, tile, correct, choice, points, at)
      VALUES (${loaded.board.id}, ${seq}, ${e.actor}, ${e.kind}, ${e.tile}, ${e.correct}, ${e.choice}, ${e.points}, ${e.at})`;
    loaded.events.push(row);
  }
  for (const tile of loaded.tiles) {
    const next = s.tiles.find((t) => t.tile === tile.tile)!;
    tile.owner = next.owner;
    tile.used_at = next.usedAt;
  }
}

type Move = (state: QuizBoardState, now: Date) => Transition;

interface MoveOptions {
  /** The client's view of the board; a different turn means the request is stale or a retry: nothing moves. */
  turn?: number;
  skipLocked?: boolean;
}

/**
 * Locks the board, applies passed deadlines (or the block that cancelled its play), then `move`, stores it all and
 * settles the play in the same transaction if the board finished. Returns null when there is no such board.
 */
async function moveBoard(
  key: BoardKey,
  language: string,
  move: Move | null,
  opts: MoveOptions = {},
): Promise<QuizBoardView | null> {
  let settled = false;
  const view = await partnerBegin(async (tx) => {
    const loaded = await lockBoard(tx, key, opts.skipLocked);
    if (!loaded) return null;
    const now = await dbNow(tx);
    const before = toState(loaded.board, loaded.tiles);
    let step: Transition =
      loaded.board.play_state !== 'started' ? cancelBoard(before, now) : advance(before, now);
    if (move && step.state.phase !== 'finished' && (opts.turn === undefined || opts.turn === step.state.turn)) {
      try {
        const next = move(step.state, now);
        const after = advance(next.state, now);
        step = { state: after.state, events: [...step.events, ...next.events, ...after.events] };
      } catch (error) {
        if (error instanceof QuizBoardMoveError) throw new PartnerError('invalid_request', error.message);
        throw error;
      }
    }
    if (step.events.length > 0) {
      if (step.state.playerScore !== playerScoreOf(step.state)) {
        throw new Error(`quiz-board ${loaded.board.id}: bank ${step.state.playerScore} != tiles`);
      }
      await persist(tx, loaded, before, step);
      if (before.phase !== 'finished' && step.state.phase === 'finished') {
        const play = await settlePartnerPlay(tx, loaded.board.play_id, step.state.playerScore, step.state.finishedAt!, undefined, {
          endCause: step.state.endReason ?? undefined,
        });
        // A block that cancelled the play after we read it wins: no event, and the board says so.
        if (play.state === 'cancelled' && step.state.endReason !== 'cancelled') {
          step = { ...step, state: { ...step.state, endReason: 'cancelled' } };
          await asSql(tx)`UPDATE partner_quiz_boards SET end_reason = 'cancelled' WHERE id = ${loaded.board.id}`;
        }
        settled = play.state === 'finished';
      }
    }
    return buildView(loaded, step.state, language, now);
  });
  if (settled) afterPartnerSettle();
  return view;
}

/** Creates the board and returns it as loaded, so the start needs no reload. */
async function createBoard(
  tx: TransactionSql,
  playId: string,
  partnerPlayerId: string,
): Promise<{ loaded: LoadedBoard; state: QuizBoardState; now: Date }> {
  const db = asSql(tx);
  const drawn = await drawBoard(tx, partnerPlayerId);
  const seed = randomBytes(32).toString('hex');
  const slots = drawn.flatMap((category, c) => category.questions.map((question, row) => ({ tile: c * 3 + row, question })));
  const now = await dbNow(tx);
  const tiles: QuizBoardTile[] = slots.map(({ tile, question }) => {
    const order = seededOptionOrder(seed, tile, question.options.length);
    return {
      tile,
      difficulty: question.difficulty,
      value: QUIZ_BOARD_VALUES[question.difficulty],
      correctIndex: order.indexOf(question.correctIndex),
      owner: null,
      usedAt: null,
    };
  });
  const state = initialState(tiles, now);
  const [board] = await db<Omit<BoardRow, 'play_state'>[]>`
    INSERT INTO partner_quiz_boards
      (play_id, partner_player_id, seed, categories, phase, turn, deadline_at)
    VALUES (${playId}, ${partnerPlayerId}, ${seed},
            ${db.json(drawn.map((c) => ({ id: c.id, name: c.name })))},
            ${state.phase}, ${state.turn}, ${state.deadlineAt})
    RETURNING *`;
  const tileRows = slots.map(({ tile, question }) => {
    const t = tiles[tile];
    const order = seededOptionOrder(seed, tile, question.options.length);
    return {
      tile,
      question_id: question.questionId,
      difficulty: question.difficulty,
      value: t.value,
      prompt: question.prompt,
      options: order.map((i) => question.options[i]),
      image: question.image ? { ...question.image } : null,
      correct_index: t.correctIndex,
    };
  });
  // ai_rank / ai_correct / ai_steal_correct are NOT NULL leftovers of the dropped AI opponent; solo play never reads
  // them, so they get fixed placeholders rather than a schema change.
  await db`
    INSERT INTO partner_quiz_board_tiles
      (board_id, tile, question_id, difficulty, value, prompt, options, image, correct_index, ai_rank, ai_correct,
       ai_steal_correct)
    SELECT ${board.id}::uuid, t.tile, t.question_id, t.difficulty, t.value, t.prompt, t.options, t.image,
           t.correct_index, t.tile, false, false
    FROM jsonb_to_recordset(${db.json(tileRows)}) AS t(
      tile smallint, question_id uuid, difficulty text, value integer, prompt jsonb, options jsonb, image jsonb,
      correct_index smallint)`;
  return {
    loaded: {
      board: { ...board, play_state: 'started' },
      tiles: tileRows.map((row): TileRow => ({ ...row, owner: null, used_at: null })),
      events: [],
    },
    state,
    now,
  };
}

function isOpenBoardConflict(error: unknown): boolean {
  const e = error as { code?: string; constraint_name?: string };
  return e?.code === '23505' && e.constraint_name === 'uq_partner_quiz_boards_open';
}

// ---------------------------------------------------------------------------------------------------------------
// Player API

/** The player's unfinished board (deadlines applied, so it may come back just finished), or null. With `playId`,
 *  that play's board in any state (a client recovering a play the sweeper or a lost response finished). */
export async function currentBoard(partner: PartnerPrincipal, playId?: string): Promise<QuizBoardView | null> {
  if (!playId) return moveBoard({ openFor: partner.playerId }, partner.language, null);
  if (!(await ownsBoard(partner, playId))) return null;
  return moveBoard({ playId }, partner.language, null);
}

async function ownsBoard(partner: PartnerPrincipal, playId: string): Promise<boolean> {
  const [owner] = await sql<{ partner_player_id: string }[]>`
    SELECT partner_player_id FROM partner_quiz_boards WHERE play_id = ${playId}`;
  return owner?.partner_player_id === partner.playerId;
}

/** Starts of one player run one at a time from the binding lookup to the binding itself, so two requests with the
 *  same start id can never return different plays (one resuming a board while the other reserves a new play). */
async function lockStarts(db: ReturnType<typeof asSql>, partner: PartnerPrincipal): Promise<void> {
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-quiz-board-start:${partner.playerId}`}, 0))`;
}

async function boundPlay(db: ReturnType<typeof asSql>, partner: PartnerPrincipal, startId: string): Promise<string | null> {
  const [row] = await db<{ play_id: string }[]>`
    SELECT play_id FROM partner_quiz_board_starts WHERE partner_player_id = ${partner.playerId} AND start_id = ${startId}`;
  return row?.play_id ?? null;
}

/** False when the start id was already bound (to this play or another). */
async function bindStart(
  db: ReturnType<typeof asSql>,
  partner: PartnerPrincipal,
  startId: string,
  playId: string,
): Promise<boolean> {
  const rows = await db`
    INSERT INTO partner_quiz_board_starts (partner_player_id, start_id, play_id)
    VALUES (${partner.playerId}, ${startId}, ${playId})
    ON CONFLICT DO NOTHING
    RETURNING 1`;
  return rows.length > 0;
}

/** Under the start lock: the play this start id is bound to, else the player's open board (now bound to it), else
 *  null (the caller reserves a new play in the same transaction). */
async function decideStart(tx: ReturnType<typeof asSql>, partner: PartnerPrincipal, startId: string): Promise<string | null> {
  await lockStarts(tx, partner);
  const bound = await boundPlay(tx, partner, startId);
  if (bound) return bound;
  const [open] = await tx<{ play_id: string }[]>`
    SELECT play_id FROM partner_quiz_boards WHERE partner_player_id = ${partner.playerId} AND phase <> 'finished'`;
  if (!open) return null;
  await bindStart(tx, partner, startId, open.play_id);
  return open.play_id;
}

function decideStartAlone(partner: PartnerPrincipal, startId: string): Promise<string | null> {
  return partnerBegin((t) => decideStart(asSql(t), partner, startId)) as Promise<string | null>;
}

/** The start id got bound to another play after the decision: the reservation rolls back. */
class StartBoundElsewhere extends Error {
  constructor(readonly playId: string) {
    super('start already bound');
  }
}

async function viewOf(partner: PartnerPrincipal, playId: string): Promise<QuizBoardView> {
  const view = await moveBoard({ playId }, partner.language, null);
  if (!view) throw new PartnerError('play_not_active');
  return view;
}

/**
 * Starts a play (or resumes the unfinished one). `startId` is the client's id for this start: every start id that
 * returned a board stays bound to that play, so a retry gets it back and never takes another play.
 */
export async function startBoard(partner: PartnerPrincipal, startId: string): Promise<QuizBoardView> {
  let outcome: { resume: string } | { created: QuizBoardView };
  try {
    outcome = await partnerBegin(async (t) => {
      const tx = asSql(t);
      const decided = await decideStart(tx, partner, startId);
      if (decided) return { resume: decided };
      // No binding means no play was ever reserved under this start id: a play, its board and its binding commit
      // together.
      const play = await reservePlay(t, {
        playerId: partner.playerId,
        sessionId: partner.sessionId,
        gameId: QUIZ_BOARD_GAME_ID,
        sourceRef: startId,
      });
      if (play.state !== 'started') throw new PartnerError('play_not_active');
      const created = await createBoard(t, play.id, partner.playerId);
      if (!(await bindStart(tx, partner, startId, play.id))) {
        const bound = await boundPlay(tx, partner, startId);
        if (bound && bound !== play.id) throw new StartBoundElsewhere(bound);
      }
      return { created: buildView(created.loaded, created.state, partner.language, created.now) };
    });
  } catch (error) {
    if (error instanceof StartBoundElsewhere) return viewOf(partner, error.playId);
    // A concurrent start with another id won (its board insert or its use of the last play came first).
    const lostRace = isOpenBoardConflict(error) || (error instanceof PartnerError && error.code === 'quota_exhausted');
    if (!lostRace) throw error;
    const winner = await decideStartAlone(partner, startId);
    if (winner) return viewOf(partner, winner);
    throw error;
  }
  return 'resume' in outcome ? viewOf(partner, outcome.resume) : outcome.created;
}

async function ownedMove(
  partner: PartnerPrincipal,
  playId: string,
  turn: number | undefined,
  move: Move,
): Promise<QuizBoardView> {
  if (!(await ownsBoard(partner, playId))) throw new PartnerError('not_found', 'Play not found');
  const view = await moveBoard({ playId }, partner.language, move, { turn });
  if (!view) throw new PartnerError('not_found', 'Play not found');
  return view;
}

export function pickBoardTile(partner: PartnerPrincipal, playId: string, turn: number, tile: number): Promise<QuizBoardView> {
  return ownedMove(partner, playId, turn, (state, now) => pickTile(state, tile, now));
}

export function answerBoardTile(partner: PartnerPrincipal, playId: string, turn: number, choice: number): Promise<QuizBoardView> {
  return ownedMove(partner, playId, turn, (state, now) => answerTile(state, choice, now));
}

/** Ends the play now with what the player has banked (the open question, if any, counts 0). */
export function leaveBoardPlay(partner: PartnerPrincipal, playId: string): Promise<QuizBoardView> {
  return ownedMove(partner, playId, undefined, (state, now) => leaveBoard(state, now));
}

// ---------------------------------------------------------------------------------------------------------------
// Sweeper: every started board ends exactly once even when nobody comes back

export async function sweepQuizBoards(limit = 50): Promise<number> {
  const due = await sql<{ id: string }[]>`
    SELECT b.id
    FROM partner_quiz_boards b
    JOIN partner_plays p ON p.id = b.play_id
    WHERE b.phase <> 'finished'
      AND (b.deadline_at < clock_timestamp() - CASE WHEN b.phase = 'answer' THEN ${`${GRACE_MS} milliseconds`}::interval ELSE interval '0' END
           OR p.state <> 'started')
    ORDER BY b.deadline_at
    LIMIT ${limit}`;
  let finished = 0;
  for (const { id } of due) {
    try {
      const view = await moveBoard({ boardId: id }, 'en', null, { skipLocked: true });
      if (view?.phase === 'finished') finished += 1;
    } catch (error) {
      logger.error({ err: error, boardId: id }, 'quiz-board sweep failed for a board');
    }
  }
  return finished;
}
