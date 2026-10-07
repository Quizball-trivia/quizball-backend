/** Freecroco ranked plays (contract §7.1): one partner_ranked_entries row per reserved play, from the queue join that
 *  reserves it to the match result that settles it. The row is keyed by the player, so it survives requeues, and it
 *  is the settlement ledger (one settlement per match and player). */

import { randomUUID } from 'node:crypto';
import { sql, type TransactionSql } from '../../../../db/index.js';
import { logger } from '../../../../core/logger.js';
import { opponentKind, partnerBegin, partnerSavepoint, recordPartnerEvent } from '../../partner-analytics.js';
import { asSql, type Db } from '../../partner-db.js';
import { PartnerError } from '../../partner-errors.js';
import type { PartnerPrincipal } from '../../partner-player-auth.js';
import { cancelPlay } from '../../partner-quota.service.js';
import { afterPartnerSettle, settlePartnerPlay, startPartnerPlay } from '../kit.js';
import {
  rankedMaxScore,
  rankedPartnerResult,
  type RankedSideResult,
  type RankedSideTally,
  type RankedTerminalCause,
} from './ranked-points.js';
import { FIRST_RANKED_POINTS_VERSION, rankedPointsVersion } from './ranked-points-store.js';

export type PartnerRankedEntryState = 'searching' | 'playing' | 'settled' | 'cancelled';

/** How a partner match ended; `no_contest` is the zero-interaction void (both plays returned). */
export type PartnerRankedCause = RankedTerminalCause | { kind: 'no_contest' } | { kind: 'pre_match_abort' };

export interface PartnerRankedEntry {
  id: string;
  playId: string;
  userId: string;
  partnerPlayerId: string;
  state: PartnerRankedEntryState;
  lobbyId: string | null;
  matchId: string | null;
  terminalCause: string | null;
  outcome: 'win' | 'loss' | 'draw' | null;
  score: number | null;
  refunded: boolean;
  createdAt: Date;
  settledAt: Date | null;
}

interface EntryRow {
  id: string;
  play_id: string;
  partner_slug: string;
  environment: string;
  user_id: string;
  partner_player_id: string;
  state: PartnerRankedEntryState;
  lobby_id: string | null;
  match_id: string | null;
  terminal_cause: string | null;
  leaver_user_id: string | null;
  /** The points table version in force when the match started; null only on entries attached before versions. */
  points_version: number | null;
  /** First time the player was shown an opponent (lobby state / match_found) on this play. */
  opponent_shown_at: Date | null;
  outcome: PartnerRankedEntry['outcome'];
  score: number | null;
  refunded: boolean;
  created_at: Date;
  settled_at: Date | null;
}

function toEntry(row: EntryRow): PartnerRankedEntry {
  return {
    id: row.id,
    playId: row.play_id,
    userId: row.user_id,
    partnerPlayerId: row.partner_player_id,
    state: row.state,
    lobbyId: row.lobby_id,
    matchId: row.match_id,
    terminalCause: row.terminal_cause,
    outcome: row.outcome,
    score: row.score,
    refunded: row.refunded,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

export async function getOpenPartnerRankedEntry(userId: string, db: Db = sql): Promise<PartnerRankedEntry | null> {
  const [row] = await db<EntryRow[]>`
    SELECT * FROM partner_ranked_entries WHERE user_id = ${userId} AND state IN ('searching', 'playing')`;
  return row ? toEntry(row) : null;
}

/** The open entry of one play: null once it has ended, or when the play is not a ranked one. */
export async function getOpenPartnerRankedEntryForPlay(playId: string, db: Db = sql): Promise<PartnerRankedEntry | null> {
  const [row] = await db<EntryRow[]>`
    SELECT * FROM partner_ranked_entries WHERE play_id = ${playId} AND state IN ('searching', 'playing')`;
  return row ? toEntry(row) : null;
}

/**
 * The player's ranked play for a queue join: the open one if any (a re-sent join or a requeue never reserves
 * twice), else a newly reserved play (quota, Tbilisi day) created together with its entry. Throws PartnerError
 * (quota_exhausted, game_not_available, player_blocked, session_ended).
 */
export async function reservePartnerRankedPlay(
  partner: PartnerPrincipal,
): Promise<{ entry: PartnerRankedEntry; reused: boolean }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const open = await getOpenPartnerRankedEntry(partner.userId);
    if (open) {
      const [play] = await sql<{ state: string }[]>`SELECT state FROM partner_plays WHERE id = ${open.playId}`;
      if (play?.state === 'started') {
        // A retry enqueues a fresh search on this play: its age, which the reconciler judges, restarts with it.
        await touchPartnerRankedSearch(partner.userId);
        return { entry: open, reused: true };
      }
      // Its play ended elsewhere (a block cancels started plays): close the entry and reserve afresh.
      await sql`
        UPDATE partner_ranked_entries
        SET state = 'cancelled', terminal_cause = COALESCE(terminal_cause, 'blocked'),
            settled_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${open.id} AND state IN ('searching', 'playing')`;
    }
    const entryId = randomUUID();
    try {
      const { result } = await startPartnerPlay(partner, 'ranked', entryId, async (tx, play) => {
        const [row] = await asSql(tx)<EntryRow[]>`
          INSERT INTO partner_ranked_entries
            (id, play_id, partner_slug, environment, partner_player_id, user_id)
          VALUES (${entryId}, ${play.id}, ${partner.slug}, ${partner.environment}, ${partner.playerId}, ${partner.userId})
          RETURNING *`;
        return toEntry(row);
      });
      return { entry: result, reused: false };
    } catch (error) {
      // A concurrent join reserved first: its open entry wins, this transaction (and its play) rolled back.
      if (isUniqueViolation(error) && attempt === 0) continue;
      throw error;
    }
  }
  throw new PartnerError('internal_error');
}

/** Plays a player gets back per day from searches or matches that ended without a result after an opponent was shown;
 *  beyond that they count as used, so cancelling until a favourable opponent appears does not pay. */
export const RANKED_RETURNS_AFTER_REVEAL_PER_DAY = 2;

/**
 * Records, before any lobby exists, that these Freecroco players are about to be shown an opponent. All or nothing:
 * every player must hold a searching entry, else nothing is recorded and false is returned. Callers fail closed (on
 * false nobody is shown anything and the searches go back), so no path — lobby state, reconnect, crash recovery — can
 * reveal an opponent without this record.
 */
export async function markPartnerRankedOpponentShown(userIds: string[]): Promise<boolean> {
  const wanted = [...new Set(userIds)];
  if (wanted.length === 0) return true;
  try {
    await sql.begin(async (t) => {
      const marked = await asSql(t)<{ user_id: string }[]>`
        UPDATE partner_ranked_entries
        SET opponent_shown_at = COALESCE(opponent_shown_at, clock_timestamp()), updated_at = clock_timestamp()
        WHERE user_id = ANY(${wanted}::uuid[]) AND state = 'searching'
        RETURNING user_id`;
      if (marked.length !== wanted.length) throw new PartnerError('play_not_active', 'A partner player has no searching ranked play');
    });
    return true;
  } catch (error) {
    logger.warn({ err: error, userIds: wanted }, 'Partner ranked opponent reveal not recorded; reveal refused');
    return false;
  }
}

/**
 * Records, before a pre-match teardown erases its evidence, which player ended the search (the one Freecroco player
 * who cancelled or went absent), on every given player's searching entry. A release that fails is retried by the
 * reconciler, which then still knows who left. Best effort: without it the daily allowance decides.
 */
export async function recordPartnerRankedLeaver(userIds: string[], leaverUserId: string): Promise<void> {
  if (userIds.length === 0) return;
  try {
    await sql`
      UPDATE partner_ranked_entries SET leaver_user_id = ${leaverUserId}, updated_at = clock_timestamp()
      WHERE user_id = ANY(${userIds}::uuid[]) AND state = 'searching'`;
  } catch (error) {
    logger.warn({ err: error, userIds, leaverUserId }, 'Partner ranked leaver not recorded');
  }
}

/**
 * Whether a play that ends without a result goes back. Before an opponent was shown it always does. After that: never
 * to the player known to have ended it; always to a player whose opponent is known to have ended it (recorded as
 * 'early_leave', so it never counts below); to anyone else only while under the daily allowance, which bounds every
 * path that cannot tell who left.
 */
async function returnsPlay(
  tx: Db,
  entry: EntryRow,
  who: { endedByThisPlayer?: boolean; endedByOpponent?: boolean },
): Promise<boolean> {
  if (entry.opponent_shown_at === null && entry.match_id === null) return true;
  if (who.endedByThisPlayer) return false;
  if (who.endedByOpponent) return true;
  const [row] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM partner_ranked_entries e
    JOIN partner_plays p ON p.id = e.play_id
    CROSS JOIN (SELECT partner_day FROM partner_plays WHERE id = ${entry.play_id}) day
    WHERE e.user_id = ${entry.user_id} AND e.id <> ${entry.id} AND e.refunded
      AND (e.opponent_shown_at IS NOT NULL OR e.match_id IS NOT NULL)
      AND e.terminal_cause IS DISTINCT FROM 'early_leave'
      AND p.partner_day = day.partner_day
      -- Entries are created on their play's Tbilisi day; the window only lets the (user_id, created_at) index serve it.
      AND e.created_at >= (day.partner_day::timestamp AT TIME ZONE 'Asia/Tbilisi') - interval '1 hour'
      AND e.created_at < (day.partner_day::timestamp AT TIME ZONE 'Asia/Tbilisi') + interval '25 hours'`;
  return (row?.n ?? 0) < RANKED_RETURNS_AFTER_REVEAL_PER_DAY;
}

/**
 * Ends a search that never became a match, with no event. Whether the play goes back is `returnsPlay`'s rule; `left`
 * says this player ended it (cancelled or went absent), `opponentLeft` that the opponent did. Only an entry still 'searching' is touched (only `playId`'s,
 * when given); a play already cancelled by a block stays used.
 */
export async function releasePartnerRankedSearch(
  userId: string,
  reason: string,
  playId?: string,
  opts: { left?: boolean; opponentLeft?: boolean } = {},
): Promise<boolean> {
  let refund = true;
  const released = await partnerBegin(async (t) => {
    const tx = asSql(t);
    const [row] = await tx<EntryRow[]>`
      SELECT * FROM partner_ranked_entries
      WHERE user_id = ${userId} AND state = 'searching' ${playId ? tx`AND play_id = ${playId}` : tx``}
      FOR UPDATE`;
    if (!row) return false;
    const [before] = await tx<{ state: string }[]>`SELECT state FROM partner_plays WHERE id = ${row.play_id}`;
    // A play the block already cancelled stays used and keeps its cause.
    const blocked = before?.state === 'cancelled';
    // Who left, as the caller knows it or as recorded before the teardown (a retried release by the reconciler).
    const left = opts.left ?? (row.leaver_user_id !== null && row.leaver_user_id === userId);
    const opponentLeft = opts.opponentLeft ?? (row.leaver_user_id !== null && row.leaver_user_id !== userId);
    refund = await returnsPlay(tx, row, { endedByThisPlayer: left, endedByOpponent: opponentLeft });
    const play = await cancelPlay(t, row.play_id, { refund, reason: refund ? 'search_cancelled' : 'left_before_match' });
    const cause = blocked ? 'blocked' : !refund || (opponentLeft && !left) ? 'early_leave' : 'search_cancelled';
    await tx`
      UPDATE partner_ranked_entries
      SET state = 'cancelled', terminal_cause = ${cause}, refunded = ${play.refunded},
          settled_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = ${row.id}`;
    return true;
  });
  if (released) logger.info({ userId, reason, refund }, 'Partner ranked search ended before a match');
  return released as boolean;
}

export type PartnerAdmission = { ok: true } | { ok: false; userId: string; reason: 'no_play' | 'blocked' | 'session_ended' };

/**
 * Before a partner match is created (where Quizball ranked consumes tickets): every partner player still holds a
 * started play, is active, and has a live session. A failure aborts the draft like missing tickets.
 */
export async function checkPartnerRankedAdmission(userIds: string[]): Promise<PartnerAdmission> {
  for (const userId of userIds) {
    const [row] = await sql<{ play_state: string | null; status: string; live_sessions: number }[]>`
      SELECT pl.state AS play_state, p.status,
             (SELECT count(*)::int FROM partner_sessions s
              WHERE s.player_id = p.id AND s.state = 'redeemed' AND s.session_expires_at > clock_timestamp()) AS live_sessions
      FROM partner_players p
      LEFT JOIN partner_ranked_entries e ON e.user_id = p.user_id AND e.state = 'searching'
      LEFT JOIN partner_plays pl ON pl.id = e.play_id
      WHERE p.user_id = ${userId}`;
    if (!row) return { ok: false, userId, reason: 'no_play' };
    if (row.status !== 'active') return { ok: false, userId, reason: 'blocked' };
    if (row.play_state !== 'started') return { ok: false, userId, reason: 'no_play' };
    if (row.live_sessions === 0) return { ok: false, userId, reason: 'session_ended' };
  }
  return { ok: true };
}

/**
 * In the match-creation transaction: each partner player's 'searching' entry becomes 'playing' on this match. Throws
 * (rolling the match back) when a partner player has no started play left.
 */
export async function attachPartnerRankedEntriesInTx(
  t: TransactionSql,
  input: { matchId: string; lobbyId: string; userIds: string[] },
): Promise<void> {
  const tx = asSql(t);
  const found: Array<{ userId: string; slug: string; environment: string; waitMs: number }> = [];
  for (const userId of input.userIds) {
    const attached = await tx<{ id: string; partner_slug: string; environment: string; wait_ms: number }[]>`
      UPDATE partner_ranked_entries e
      SET state = 'playing', match_id = ${input.matchId}, lobby_id = ${input.lobbyId}, leaver_user_id = NULL,
          updated_at = clock_timestamp()
      FROM partner_plays pl
      WHERE e.user_id = ${userId} AND e.state = 'searching' AND pl.id = e.play_id AND pl.state = 'started'
      RETURNING e.id, e.partner_slug, e.environment,
        floor(extract(epoch FROM clock_timestamp() - e.created_at) * 1000)::float8 AS wait_ms`;
    if (attached.length !== 1) {
      throw new PartnerError('play_not_active', `Partner player ${userId} has no started ranked play for this match`);
    }
    const [entry] = attached;
    found.push({ userId, slug: entry!.partner_slug, environment: entry!.environment, waitMs: entry!.wait_ms });
  }
  if (found.length > 0) {
    const seated = await tx<{ user_id: string; is_ai: boolean | null; partner_slug: string | null }[]>`
      SELECT mp.user_id, u.is_ai, u.partner_slug FROM match_players mp LEFT JOIN users u ON u.id = mp.user_id
      WHERE mp.match_id = ${input.matchId}`;
    for (const f of found) {
      recordPartnerEvent(t, {
        event: 'partner_ranked_match_found',
        userId: f.userId,
        slug: f.slug,
        partnerEnvironment: f.environment,
        key: `${input.matchId}:${f.userId}`,
        properties: {
          game_id: 'ranked',
          opponent_kind: opponentKind(seated.find((p) => p.user_id !== f.userId)),
          wait_ms: f.waitMs,
        },
      });
    }
  }
  // One statement, one snapshot: both players of the match are scored by the same version of the points table.
  await tx`
    UPDATE partner_ranked_entries e SET points_version = v.ranked_points_version
    FROM partner_config_versions v
    WHERE e.match_id = ${input.matchId} AND e.state = 'playing'
      AND v.partner_slug = e.partner_slug AND v.environment = e.environment`;
}

function causeLabel(cause: PartnerRankedCause): string {
  return cause.kind === 'pre_match_abort' ? 'search_cancelled' : cause.kind;
}

/** Turns the extra causes into the contract's table: a zero-interaction void and a pre-match abort return both plays. */
function asTableCause(cause: PartnerRankedCause): RankedTerminalCause {
  return cause.kind === 'no_contest' || cause.kind === 'pre_match_abort' ? { kind: 'server_failure' } : cause;
}

/**
 * Settles every partner player of a finished match inside the caller's result transaction: a score finishes the
 * play and queues its event (a play cancelled by a block gets none), a cancellation returns or keeps the play.
 * Idempotent: only entries still 'playing' are touched. Returns true when anything was settled.
 */
export async function settlePartnerRankedMatchInTx(
  t: TransactionSql,
  matchId: string,
  endedBy: PartnerRankedCause,
): Promise<boolean> {
  let cause = endedBy;
  const tx = asSql(t);
  const entries = await tx<EntryRow[]>`
    SELECT * FROM partner_ranked_entries WHERE match_id = ${matchId} AND state = 'playing' ORDER BY user_id FOR UPDATE`;
  if (entries.length === 0) return false;
  // Every partner player of the match holds exactly one ledger row; anything else must not settle half a match.
  const uncovered = await tx<{ user_id: string }[]>`
    SELECT mp.user_id FROM match_players mp JOIN users u ON u.id = mp.user_id
    WHERE mp.match_id = ${matchId} AND u.partner_slug IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM partner_ranked_entries e WHERE e.match_id = ${matchId} AND e.user_id = mp.user_id)`;
  if (uncovered.length > 0) {
    throw new Error(`Partner ranked match ${matchId} has partner players without a play: ${uncovered.map((r) => r.user_id).join(',')}`);
  }

  // The block cancelled its play in the block's own transaction: that is the durable record that the blocked player
  // left (contract §5.5), whatever path ended the match afterwards (a crash may have skipped the block's forfeit).
  const blockedRows = await tx<{ user_id: string }[]>`
    SELECT e.user_id FROM partner_ranked_entries e JOIN partner_plays pl ON pl.id = e.play_id
    WHERE e.match_id = ${matchId} AND e.state = 'playing' AND pl.state = 'cancelled'`;
  if (cause.kind === 'natural' && blockedRows.length === 1) {
    cause = { kind: 'left', leaverUserId: blockedRows[0]!.user_id };
  }
  const [match] = await tx<{ ended_at: Date | null }[]>`SELECT ended_at FROM matches WHERE id = ${matchId}`;
  const players = await tx<{
    user_id: string; goals: number; penalty_goals: number; correct_answers: number; is_ai: boolean | null; partner_slug: string | null;
  }[]>`
    SELECT mp.user_id, mp.goals, mp.penalty_goals, mp.correct_answers, u.is_ai, u.partner_slug
    FROM match_players mp LEFT JOIN users u ON u.id = mp.user_id
    WHERE mp.match_id = ${matchId} ORDER BY mp.seat`;
  const at = match?.ended_at ?? undefined;

  let results: Map<string, RankedSideResult>;
  let maxScore: number | undefined;
  if (players.length === 2) {
    const sides = players.map<RankedSideTally>((p) => ({
      userId: p.user_id,
      goals: p.goals,
      penaltyGoals: p.penalty_goals,
      correctAnswers: p.correct_answers,
    })) as [RankedSideTally, RankedSideTally];
    const first = entries[0]!;
    const table = await rankedPointsVersion(
      { slug: first.partner_slug, environment: first.environment },
      first.points_version ?? FIRST_RANKED_POINTS_VERSION,
      tx,
    );
    results = rankedPartnerResult(sides, asTableCause(cause), table);
    maxScore = rankedMaxScore(table);
  } else {
    logger.error({ matchId, players: players.length }, 'Partner ranked match without two players; plays returned');
    results = new Map(entries.map((e) => [e.user_id, { kind: 'cancel', refund: true }]));
  }

  for (const entry of entries) {
    const result: RankedSideResult = results.get(entry.user_id) ?? { kind: 'cancel', refund: true };
    if (result.kind === 'score') {
      const me = players.find((p) => p.user_id === entry.user_id);
      const opponent = players.find((p) => p.user_id !== entry.user_id);
      const play = await settlePartnerPlay(t, entry.play_id, result.score, at, maxScore, {
        endCause: causeLabel(cause),
        outcome: result.outcome,
        goalMargin: me && opponent ? me.goals - opponent.goals : undefined,
        opponentKind: opponentKind(opponent),
      });
      const blocked = play.state === 'cancelled';
      await tx`
        UPDATE partner_ranked_entries
        SET state = ${blocked ? 'cancelled' : 'settled'}, terminal_cause = ${blocked ? 'blocked' : causeLabel(cause)},
            outcome = ${result.outcome}, score = ${blocked ? null : play.score},
            settled_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${entry.id}`;
    } else {
      const leaver = 'leaverUserId' in cause ? cause.leaverUserId : null;
      const refund = result.refund && await returnsPlay(tx, entry, {
        endedByThisPlayer: leaver === entry.user_id,
        endedByOpponent: leaver !== null && leaver !== entry.user_id,
      });
      const play = await cancelPlay(t, entry.play_id, { refund, reason: causeLabel(cause) });
      await tx`
        UPDATE partner_ranked_entries
        SET state = 'cancelled', terminal_cause = ${causeLabel(cause)}, refunded = ${play.refunded},
            settled_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${entry.id}`;
    }
  }
  logger.info({ matchId, cause: causeLabel(cause), players: entries.length }, 'Partner ranked match settled');
  return true;
}

/**
 * The partner step of a match's terminal transaction. It runs in a savepoint: a failure must not keep the match from
 * ending, so the cause is staged on the entries instead and the reconciler settles them with it.
 */
export async function settlePartnerRankedMatchSafely(
  t: TransactionSql,
  matchId: string,
  cause: PartnerRankedCause,
): Promise<void> {
  try {
    await partnerSavepoint(t, (sp) => settlePartnerRankedMatchInTx(sp, matchId, cause));
  } catch (error) {
    logger.error({ err: error, matchId, cause: causeLabel(cause) }, 'Partner ranked settlement failed; cause staged for the reconciler');
    const leaver = 'leaverUserId' in cause ? cause.leaverUserId : null;
    await asSql(t)`
      UPDATE partner_ranked_entries
      SET terminal_cause = ${causeLabel(cause)}, leaver_user_id = ${leaver}, updated_at = clock_timestamp()
      WHERE match_id = ${matchId} AND state = 'playing'`;
  }
}

/** Whether a match carries partner provenance (matches.partner_pool set at creation). */
export function isPartnerMatch(match: { partner_pool?: string | null } | null | undefined): boolean {
  return match?.partner_pool != null;
}

/** Settles a match that ended outside a terminal transaction of ours (a raw abandon) or whose settlement failed. */
export async function reconcilePartnerRankedMatch(matchId: string): Promise<boolean> {
  const settled = await partnerBegin(async (t) => {
    const tx = asSql(t);
    const [match] = await tx<{ status: string; winner_user_id: string | null; state_payload: Record<string, unknown> | null }[]>`
      SELECT status, winner_user_id, state_payload FROM matches WHERE id = ${matchId} FOR UPDATE`;
    if (!match || match.status === 'active') return false;
    const [staged] = await tx<{ terminal_cause: string | null; leaver_user_id: string | null }[]>`
      SELECT terminal_cause, leaver_user_id FROM partner_ranked_entries
      WHERE match_id = ${matchId} AND state = 'playing' AND terminal_cause IS NOT NULL LIMIT 1`;
    const cause = staged ? stagedCause(staged) : derivedCause(match, await tx<{ user_id: string }[]>`
      SELECT user_id FROM match_players WHERE match_id = ${matchId}`);
    return settlePartnerRankedMatchInTx(t, matchId, cause);
  });
  if (settled) afterPartnerSettle();
  return settled as boolean;
}

function stagedCause(staged: { terminal_cause: string | null; leaver_user_id: string | null }): PartnerRankedCause {
  switch (staged.terminal_cause) {
    case 'natural':
    case 'both_dropped':
    case 'server_failure':
    case 'no_contest':
      return { kind: staged.terminal_cause };
    case 'search_cancelled':
      return { kind: 'pre_match_abort' };
    case 'left':
    case 'early_leave':
      if (staged.leaver_user_id) return { kind: staged.terminal_cause, leaverUserId: staged.leaver_user_id };
      return { kind: 'server_failure' };
    default:
      return { kind: 'server_failure' };
  }
}

/** Best reading of a terminal match without a staged cause: a forfeit has the loser as leaver; an abandon returns both. */
function derivedCause(
  match: { status: string; winner_user_id: string | null; state_payload: Record<string, unknown> | null },
  players: Array<{ user_id: string }>,
): PartnerRankedCause {
  if (match.status !== 'completed') return { kind: 'server_failure' };
  if (match.state_payload?.winnerDecisionMethod === 'forfeit' && match.winner_user_id) {
    const leaver = players.find((p) => p.user_id !== match.winner_user_id);
    if (leaver) return { kind: 'left', leaverUserId: leaver.user_id };
  }
  return { kind: 'natural' };
}

/** Open entries the reconciler looks at: matches that ended, and searches idle for a while. */
export async function listPartnerRankedReconcileWork(idleSearchSeconds: number): Promise<{
  endedMatchIds: string[];
  /** Plays a block cancelled while their match was running, the match still active (the block's forfeit was lost). */
  blockedInActiveMatch: Array<{ userId: string; playId: string }>;
  staleSearches: Array<{ userId: string; playId: string; staleSeconds: number }>;
}> {
  const ended = await sql<{ match_id: string }[]>`
    SELECT DISTINCT e.match_id FROM partner_ranked_entries e
    JOIN matches m ON m.id = e.match_id
    WHERE e.state = 'playing' AND m.status <> 'active'
    LIMIT 100`;
  const stale = await sql<{ user_id: string; play_id: string; stale_seconds: number }[]>`
    SELECT user_id, play_id, extract(epoch FROM clock_timestamp() - updated_at)::int AS stale_seconds
    FROM partner_ranked_entries
    WHERE state = 'searching' AND updated_at < clock_timestamp() - make_interval(secs => ${idleSearchSeconds})
    ORDER BY updated_at LIMIT 100`;
  const blocked = await sql<{ user_id: string; play_id: string }[]>`
    SELECT e.user_id, e.play_id FROM partner_ranked_entries e
    JOIN partner_plays pl ON pl.id = e.play_id
    JOIN matches m ON m.id = e.match_id
    WHERE e.state = 'playing' AND pl.state = 'cancelled' AND m.status = 'active'
    LIMIT 100`;
  return {
    endedMatchIds: ended.map((r) => r.match_id),
    blockedInActiveMatch: blocked.map((r) => ({ userId: r.user_id, playId: r.play_id })),
    staleSearches: stale.map((r) => ({ userId: r.user_id, playId: r.play_id, staleSeconds: r.stale_seconds })),
  };
}

/** Seconds since a play's search was last seen alive; null once that search has ended. */
export async function partnerRankedSearchAge(playId: string): Promise<number | null> {
  const [row] = await sql<{ age: number }[]>`
    SELECT extract(epoch FROM clock_timestamp() - updated_at)::int AS age
    FROM partner_ranked_entries WHERE play_id = ${playId} AND state = 'searching'`;
  return row ? row.age : null;
}

/** Marks a still-searching entry as seen alive, so the idle sweep only returns plays that really stalled. Returns its
 *  play, or null when the player has no search open on a started play. */
export async function touchPartnerRankedSearch(userId: string): Promise<string | null> {
  const [row] = await sql<{ play_id: string }[]>`
    UPDATE partner_ranked_entries e SET updated_at = clock_timestamp()
    FROM partner_plays pl
    WHERE e.user_id = ${userId} AND e.state = 'searching' AND pl.id = e.play_id AND pl.state = 'started'
    RETURNING e.play_id`;
  return row?.play_id ?? null;
}

export interface PartnerRankedResult {
  playId: string;
  matchId: string | null;
  state: PartnerRankedEntryState;
  score: number | null;
  outcome: PartnerRankedEntry['outcome'];
  terminalCause: string | null;
  refunded: boolean;
}

/** This player's ranked play for a match (the result screen polls it until the play is settled or cancelled). */
export async function getPartnerRankedResult(userId: string, matchId: string): Promise<PartnerRankedResult | null> {
  const [row] = await sql<EntryRow[]>`
    SELECT * FROM partner_ranked_entries WHERE user_id = ${userId} AND match_id = ${matchId}`;
  if (!row) return null;
  return {
    playId: row.play_id,
    matchId: row.match_id,
    state: row.state,
    score: row.score,
    outcome: row.outcome,
    terminalCause: row.terminal_cause,
    refunded: row.refunded,
  };
}

/** Matches the two players already had against each other today (Tbilisi day of the plays). */
export async function countPartnerMatchesBetweenToday(userAId: string, userBId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(DISTINCT a.match_id)::int AS n
    FROM partner_ranked_entries a
    JOIN partner_ranked_entries b ON b.match_id = a.match_id AND b.user_id = ${userBId}
    JOIN partner_plays p ON p.id = a.play_id
    WHERE a.user_id = ${userAId} AND a.match_id IS NOT NULL
      AND p.partner_day = (clock_timestamp() AT TIME ZONE 'Asia/Tbilisi')::date`;
  return row?.n ?? 0;
}

/** The names partner players are shown under (users.nickname of a partner player is an internal handle). */
export async function partnerDisplayNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await sql<{ user_id: string; display_name: string | null }[]>`
    SELECT user_id, display_name FROM partner_players WHERE user_id = ANY(${userIds}::uuid[])`;
  return new Map(rows.filter((r) => r.display_name).map((r) => [r.user_id, r.display_name!]));
}
