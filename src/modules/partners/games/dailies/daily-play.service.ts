/** Server-authoritative play of the Freecroco dailies. The selected set stays in partner_daily_plays; the browser gets
 *  the current item only and its reveal only once the item is resolved. Every transition locks the play row, so an
 *  answer, a skip, a timeout and the sweeper can never both apply to the same item.
 *
 *  Item lifecycle: open (deadline running) → resolved (answered, timed out or skipped; `item_done_at` set) → the
 *  player asks for the next item, which opens with a fresh deadline. After the last item the play settles once:
 *  finished (score event queued by the kit) or cancelled (blocked player, no event). */

import { sql } from '../../../../db/index.js';
import { partnerBegin } from '../../partner-analytics.js';
import { logger } from '../../../../core/logger.js';
import { asSql, type Db } from '../../partner-db.js';
import { PartnerError } from '../../partner-errors.js';
import { PARTNER_GAME_MAX_SCORE } from '../../partner-games.js';
import type { PartnerPrincipal } from '../../partner-player-auth.js';
import { afterPartnerSettle, settlePartnerPlay, startPartnerPlay } from '../kit.js';
import { drawPlayItems, publicDailyQuestionIds } from './content-pool.js';
import { PARTNER_DAILY_RULES, type AnyDailyRules, type EndCause, type PartnerDailyGameId } from './daily-rules.js';

/** Answers that left the browser in time may arrive this much after the deadline. */
export const ANSWER_GRACE_MS = 1_000;
/** An item left this long past its end without the next being asked for: the player has gone. */
export const ABANDON_AFTER_MS = 60_000;
const RECENT_DAYS = 30;

interface PlayRow {
  play_id: string;
  game_id: PartnerDailyGameId;
  player_id: string;
  question_ids: string[];
  items: Array<{ qid: string }>;
  item_states: Array<{ resolved: boolean; cause?: EndCause }>;
  current_index: number;
  item_deadline: Date;
  item_done_at: Date | null;
  score: number;
  state: 'playing' | 'finished' | 'cancelled';
  end_cause: string | null;
  ended_at: Date | null;
}

export interface DailyPlayView {
  playId: string;
  gameId: PartnerDailyGameId;
  state: 'playing' | 'finished' | 'cancelled';
  itemCount: number;
  secondsPerItem: number;
  index: number;
  score: number;
  /** The current item as the player may see it; null once the play has ended. */
  item: unknown;
  resolved: boolean;
  reveal: unknown;
  itemPoints: number | null;
  /** Server-measured, so the browser's clock never matters. */
  remainingMs: number;
}

export interface DailyAnswerResult {
  view: DailyPlayView;
  /** The judgement of this answer; null for a stale or repeated request. */
  feedback: unknown;
  /** The answer reached the server after the item's time ran out. */
  late?: boolean;
}

function rulesFor(gameId: PartnerDailyGameId): AnyDailyRules {
  return PARTNER_DAILY_RULES[gameId];
}

function totalScore(rules: AnyDailyRules, row: Pick<PlayRow, 'items' | 'item_states'>): number {
  return row.items.reduce((sum, item, i) => sum + rules.points(item, row.item_states[i]), 0);
}

function countdownFound(row: Pick<PlayRow, 'item_states'>): number {
  return row.item_states.reduce((n, s) => n + ((s as { found?: string[] }).found?.length ?? 0), 0);
}

export function toView(row: PlayRow, now: Date, locale: string): DailyPlayView {
  const rules = rulesFor(row.game_id);
  const ended = row.state !== 'playing';
  const item = row.items[row.current_index];
  const state = row.item_states[row.current_index];
  return {
    playId: row.play_id,
    gameId: row.game_id,
    state: row.state,
    itemCount: rules.itemCount,
    secondsPerItem: rules.secondsPerItem,
    index: row.current_index,
    score: Math.min(row.score, PARTNER_GAME_MAX_SCORE[row.game_id]),
    // A completed play keeps its last item so the browser can show that item's reveal before the result.
    item: ended && row.end_cause !== 'completed' ? null : rules.view(item, state, locale),
    resolved: ended || state.resolved,
    reveal: state.resolved ? rules.reveal(item, state, locale) : null,
    itemPoints: state.resolved ? rules.points(item, state) : null,
    remainingMs: ended || state.resolved ? 0 : Math.max(0, row.item_deadline.getTime() - now.getTime()),
  };
}

async function dbNow(tx: Db): Promise<Date> {
  const [{ now }] = await tx<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return now;
}

/**
 * Locks the player, then the play row: the order a block uses (player → plays → this row, via the trigger in the
 * migration), so the two can never deadlock. The play is reconciled with its parent before anything reads it.
 */
async function lockPlay(tx: Db, principal: PartnerPrincipal, gameId: PartnerDailyGameId, playId: string): Promise<PlayRow> {
  await tx`SELECT 1 FROM partner_players WHERE id = ${principal.playerId} FOR SHARE`;
  const [row] = await tx<PlayRow[]>`
    SELECT * FROM partner_daily_plays WHERE play_id = ${playId} AND game_id = ${gameId} FOR UPDATE`;
  if (!row || row.player_id !== principal.playerId) throw new PartnerError('not_found', 'Play not found');
  await followParent(tx, row);
  return row;
}

/** A parent play cancelled by a block ends this one too (no event; the play stays used). The block's trigger does
 *  this at once; checking here as well keeps a row that predates the trigger from resuming. */
async function followParent(tx: Db, row: PlayRow): Promise<void> {
  if (row.state !== 'playing') return;
  const [parent] = await tx<{ state: string }[]>`SELECT state FROM partner_plays WHERE id = ${row.play_id}`;
  if (parent?.state !== 'cancelled') return;
  row.state = 'cancelled';
  row.end_cause = 'blocked';
  row.ended_at = await dbNow(tx);
  await save(tx, row);
}

/** Closes the current item if its time ran out (it ended at its deadline). Mutates `row`; true when it did. */
function applyTimeout(rules: AnyDailyRules, row: PlayRow, now: Date): boolean {
  if (row.state !== 'playing') return false;
  const state = row.item_states[row.current_index];
  if (state.resolved || now.getTime() <= row.item_deadline.getTime() + ANSWER_GRACE_MS) return false;
  closeCurrent(rules, row, 'timeout', row.item_deadline);
  return true;
}

function endedBy(row: PlayRow, now: Date): Date {
  return now.getTime() > row.item_deadline.getTime() ? row.item_deadline : now;
}

function closeCurrent(rules: AnyDailyRules, row: PlayRow, cause: EndCause, at: Date): void {
  const i = row.current_index;
  row.item_states = row.item_states.map((s, k) => (k === i ? rules.close(row.items[i], s, cause) : s));
  row.item_done_at = at;
  row.score = totalScore(rules, row);
}

async function save(tx: Db, row: PlayRow): Promise<void> {
  await tx`
    UPDATE partner_daily_plays
    SET item_states = ${tx.json(row.item_states as never)}, current_index = ${row.current_index},
        item_deadline = ${row.item_deadline}, item_done_at = ${row.item_done_at}, score = ${row.score},
        state = ${row.state}, end_cause = ${row.end_cause}, ended_at = ${row.ended_at}, updated_at = clock_timestamp()
    WHERE play_id = ${row.play_id}`;
}

/**
 * Ends the play with the points earned so far and queues its single score event (via the kit, same transaction).
 * `at` = when it logically ended. Returns true when a score event was queued.
 */
async function settle(tx: Db, rules: AnyDailyRules, row: PlayRow, cause: 'completed' | 'quit' | 'abandoned', at: Date): Promise<boolean> {
  if (row.state !== 'playing') return false;
  if (!row.item_states[row.current_index].resolved) closeCurrent(rules, row, cause === 'quit' ? 'skipped' : 'timeout', at);
  row.score = totalScore(rules, row);
  const play = await settlePartnerPlay(tx as never, row.play_id, Math.min(row.score, PARTNER_GAME_MAX_SCORE[row.game_id]), at, undefined, {
    endCause: cause,
  });
  row.state = play.state === 'finished' ? 'finished' : 'cancelled';
  row.end_cause = row.state === 'cancelled' ? 'blocked' : cause;
  row.ended_at = await dbNow(tx);
  await save(tx, row);
  return row.state === 'finished';
}

/** Settles as soon as the last item is closed, in the same transaction: a block arriving before the browser's `next`
 *  must not cancel a play that is already complete (contract §5.5). */
async function settleIfComplete(tx: Db, rules: AnyDailyRules, row: PlayRow): Promise<boolean> {
  if (row.state !== 'playing' || row.current_index + 1 < row.items.length || !row.item_states[row.current_index].resolved) return false;
  return settle(tx, rules, row, 'completed', row.item_done_at ?? row.item_deadline);
}

async function inPlay<T>(fn: (tx: Db) => Promise<{ result: T; settled: boolean }>): Promise<T> {
  const { result, settled } = await partnerBegin((t) => fn(asSql(t)));
  if (settled) afterPartnerSettle();
  return result;
}

export async function getOpenPlay(principal: PartnerPrincipal, gameId: PartnerDailyGameId, locale: string): Promise<DailyPlayView | null> {
  const [open] = await sql<{ play_id: string }[]>`
    SELECT play_id FROM partner_daily_plays WHERE player_id = ${principal.playerId} AND game_id = ${gameId} AND state = 'playing'`;
  if (!open) return null;
  const view = await getPlay(principal, gameId, open.play_id, locale);
  // This read may have just closed the last item: hand over the finished play so the browser shows its result.
  return view.state === 'cancelled' ? null : view;
}

/** The play as it stands now (a reload resumes here). An item whose time and grace have run out is closed first: this
 *  read is how the browser asks for an automatic timeout. */
export async function getPlay(principal: PartnerPrincipal, gameId: PartnerDailyGameId, playId: string, locale: string): Promise<DailyPlayView> {
  const rules = rulesFor(gameId);
  return inPlay(async (tx) => {
    const row = await lockPlay(tx, principal, gameId, playId);
    const now = await dbNow(tx);
    if (!applyTimeout(rules, row, now)) return { result: toView(row, now, locale), settled: false };
    await save(tx, row);
    const settled = await settleIfComplete(tx, rules, row);
    return { result: toView(row, now, locale), settled };
  });
}

export async function startPlay(principal: PartnerPrincipal, gameId: PartnerDailyGameId, startId: string, locale: string): Promise<DailyPlayView> {
  const open = await getOpenPlay(principal, gameId, locale);
  if (open?.state === 'playing') return open;
  const rules = rulesFor(gameId);
  const excluded = await publicDailyQuestionIds(gameId);
  const recent = await sql<{ id: string }[]>`
    SELECT DISTINCT unnest(question_ids)::text AS id FROM partner_daily_plays
    WHERE player_id = ${principal.playerId} AND game_id = ${gameId}
      AND created_at > clock_timestamp() - make_interval(days => ${RECENT_DAYS})`;
  try {
    const { result } = await startPartnerPlay(principal, gameId, `daily:${startId}`, async (t, play) => {
      const tx = asSql(t);
      const [existing] = await tx<PlayRow[]>`SELECT * FROM partner_daily_plays WHERE play_id = ${play.id}`;
      if (existing) return existing;
      if (play.state !== 'started') throw new PartnerError('play_not_active');
      const items = await drawPlayItems(tx, rules, principal.slug, { excluded, recent: recent.map((r) => r.id) });
      if (!items) {
        logger.error({ gameId }, 'Partner dailies: not enough content in the partner pool');
        throw new PartnerError('game_not_available', 'This game has no content right now');
      }
      const [row] = await tx<PlayRow[]>`
        INSERT INTO partner_daily_plays (play_id, game_id, player_id, question_ids, items, item_states, item_deadline)
        VALUES (${play.id}, ${gameId}, ${principal.playerId}, ${items.map((i) => i.qid)}::uuid[],
                ${tx.json(items as never)}, ${tx.json(items.map((i) => rules.initialState(i)) as never)},
                clock_timestamp() + make_interval(secs => ${rules.secondsPerItem}))
        RETURNING *`;
      return row;
    });
    return getPlay(principal, gameId, result.play_id, locale);
  } catch (error) {
    // A concurrent start with another id won the one open play (or used the day's last play): show that one.
    const lostRace = (error as { constraint_name?: string }).constraint_name === 'uq_partner_daily_plays_open'
      || (error instanceof PartnerError && error.code === 'quota_exhausted');
    if (lostRace) {
      const winner = await getOpenPlay(principal, gameId, locale);
      if (winner?.state === 'playing') return winner;
    }
    throw error;
  }
}

export async function answerItem(
  principal: PartnerPrincipal,
  gameId: PartnerDailyGameId,
  input: { playId: string; index: number; answer?: unknown },
  locale: string,
): Promise<DailyAnswerResult> {
  const rules = rulesFor(gameId);
  const answer = rules.input.parse(input.answer);
  return inPlay<DailyAnswerResult>(async (tx) => {
    const row = await lockPlay(tx, principal, gameId, input.playId);
    const now = await dbNow(tx);
    if (row.state !== 'playing' || input.index !== row.current_index) {
      return { result: { view: toView(row, now, locale), feedback: null }, settled: false };
    }
    if (applyTimeout(rules, row, now)) {
      await save(tx, row);
      const settled = await settleIfComplete(tx, rules, row);
      return { result: { view: toView(row, now, locale), feedback: null, late: true }, settled };
    }
    const i = row.current_index;
    if (row.item_states[i].resolved) return { result: { view: toView(row, now, locale), feedback: null }, settled: false };
    const judged = rules.answer(row.items[i], row.item_states[i], answer, { foundInPlay: countdownFound(row), locale });
    row.item_states = row.item_states.map((s, k) => (k === i ? judged.state : s));
    // An answer accepted inside the grace is dated when we accepted it (contract §6), like every other game.
    if (judged.state.resolved) row.item_done_at = now;
    row.score = totalScore(rules, row);
    await save(tx, row);
    const settled = await settleIfComplete(tx, rules, row);
    return { result: { view: toView(row, now, locale), feedback: judged.feedback }, settled };
  });
}

/**
 * Moves past item `index`. An item still open is skipped by the player's own choice (it scores what it has); an
 * automatic timeout is never asked for here but by reading the play once the grace has passed, so an answer still
 * in flight inside the grace is never made stale. Then the next item opens with a fresh deadline, or the play settles
 * after the last. Repeating it for an index already passed changes nothing.
 */
export async function nextItem(principal: PartnerPrincipal, gameId: PartnerDailyGameId, input: { playId: string; index: number }, locale: string): Promise<DailyPlayView> {
  const rules = rulesFor(gameId);
  return inPlay(async (tx) => {
    const row = await lockPlay(tx, principal, gameId, input.playId);
    const now = await dbNow(tx);
    if (row.state !== 'playing' || input.index !== row.current_index) return { result: toView(row, now, locale), settled: false };
    applyTimeout(rules, row, now);
    if (!row.item_states[row.current_index].resolved) closeCurrent(rules, row, 'skipped', endedBy(row, now));
    if (row.current_index + 1 >= row.items.length) {
      const settled = await settle(tx, rules, row, 'completed', row.item_done_at ?? now);
      return { result: toView(row, now, locale), settled };
    }
    row.current_index += 1;
    row.item_deadline = new Date(now.getTime() + rules.secondsPerItem * 1000);
    row.item_done_at = null;
    await save(tx, row);
    return { result: toView(row, now, locale), settled: false };
  });
}

/** The player leaves: the play ends with what they had earned (contract §7), now, or when its last item had already
 *  ended (an item that ran out ended at its deadline). */
export async function quitPlay(principal: PartnerPrincipal, gameId: PartnerDailyGameId, playId: string, locale: string): Promise<DailyPlayView> {
  const rules = rulesFor(gameId);
  return inPlay(async (tx) => {
    const row = await lockPlay(tx, principal, gameId, playId);
    const now = await dbNow(tx);
    if (row.state !== 'playing') return { result: toView(row, now, locale), settled: false };
    applyTimeout(rules, row, now);
    const ended = row.item_states[row.current_index].resolved ? (row.item_done_at ?? now) : now;
    const settled = await settle(tx, rules, row, 'quit', ended);
    return { result: toView(row, now, locale), settled };
  });
}

/**
 * Settles plays whose player has gone: the current item ended (or its time ran out) more than ABANDON_AFTER_MS ago
 * and nobody asked for the next. Scored with what was earned; `occurredAt` = when the item ended.
 */
export async function sweepAbandonedDailyPlays(limit = 50): Promise<number> {
  const due = await sql<{ play_id: string; player_id: string }[]>`
    SELECT play_id, player_id FROM partner_daily_plays
    WHERE state = 'playing'
      AND COALESCE(item_done_at, item_deadline) < clock_timestamp() - make_interval(secs => ${ABANDON_AFTER_MS / 1000})
    ORDER BY item_deadline
    LIMIT ${limit}`;
  let settled = 0;
  for (const { play_id, player_id } of due) {
    try {
      const done = await partnerBegin(async (t) => {
        const tx = asSql(t);
        // Same lock order as the player routes and a block; a player being blocked right now is left to that block.
        const [player] = await tx`SELECT 1 FROM partner_players WHERE id = ${player_id} FOR SHARE SKIP LOCKED`;
        if (!player) return false;
        const [row] = await tx<PlayRow[]>`
          SELECT * FROM partner_daily_plays WHERE play_id = ${play_id} AND state = 'playing' FOR UPDATE SKIP LOCKED`;
        if (!row) return false;
        await followParent(tx, row);
        if (row.state !== 'playing') return false;
        const now = await dbNow(tx);
        // Re-checked under the lock: the player may have moved on since the scan.
        const end = row.item_done_at ?? row.item_deadline;
        if (now.getTime() - end.getTime() < ABANDON_AFTER_MS) return false;
        const rules = rulesFor(row.game_id);
        applyTimeout(rules, row, now);
        return settle(tx, rules, row, 'abandoned', row.item_done_at ?? row.item_deadline);
      });
      if (done) settled += 1;
    } catch (error) {
      logger.error({ err: error, playId: play_id }, 'Partner dailies sweeper could not settle a play');
    }
  }
  if (settled > 0) afterPartnerSettle();
  return settled;
}
