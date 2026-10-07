/** Daily plays per partner player and game (contract §7): counted on the Asia/Tbilisi day a play starts, the
 *  effective limit being the date override else the game's default. Game streams call reservePlay / finishPlay /
 *  cancelPlay inside their own transactions; delivery of a finished play is wired by the caller. */

import { sql, type TransactionSql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { asSql } from './partner-db.js';
import { PartnerError } from './partner-errors.js';
import { isPartnerGameId, nextPartnerMidnight, PARTNER_GAME_MAX_SCORE, type PartnerGameId } from './partner-games.js';
import { currentRankedMaxScore } from './games/ranked/ranked-points-store.js';
import { recordPartnerEvent, type PartnerPlayDetails } from './partner-analytics.js';

export interface PartnerPlay {
  id: string;
  partnerSlug: string;
  environment: string;
  playerId: string;
  sessionId: string;
  gameId: PartnerGameId;
  /** 'YYYY-MM-DD', Asia/Tbilisi */
  partnerDay: string;
  state: 'started' | 'finished' | 'cancelled';
  score: number | null;
  limitSnapshot: number;
  sourceRef: string;
  refunded: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  cancelledAt: Date | null;
}

interface PlayRow {
  id: string;
  partner_slug: string;
  environment: string;
  player_id: string;
  session_id: string;
  game_id: PartnerGameId;
  partner_day: Date | string;
  state: PartnerPlay['state'];
  score: number | null;
  limit_snapshot: number;
  source_ref: string;
  refunded: boolean;
  started_at: Date;
  finished_at: Date | null;
  cancelled_at: Date | null;
}

function toPlay(row: PlayRow): PartnerPlay {
  return {
    id: row.id,
    partnerSlug: row.partner_slug,
    environment: row.environment,
    playerId: row.player_id,
    sessionId: row.session_id,
    gameId: row.game_id,
    // postgres.js reads a date as UTC midnight.
    partnerDay: typeof row.partner_day === 'string' ? row.partner_day : row.partner_day.toISOString().slice(0, 10),
    state: row.state,
    score: row.score,
    limitSnapshot: row.limit_snapshot,
    sourceRef: row.source_ref,
    refunded: row.refunded,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cancelledAt: row.cancelled_at,
  };
}

export interface ReservePlayInput {
  /** partner_players.id */
  playerId: string;
  sessionId: string;
  gameId: PartnerGameId;
  /** The game's own id for this play (match participant, run id…): a retried start returns the same play. */
  sourceRef: string;
  /** Test hook: the instant the play starts (default: the database clock). */
  at?: Date;
}

/**
 * Reserves one of today's plays: locks the (player, game, day) counter, so concurrent starts can never exceed the
 * limit. Throws player_blocked, session_ended, game_not_available or quota_exhausted.
 */
export async function reservePlay(t: TransactionSql, input: ReservePlayInput): Promise<PartnerPlay> {
  const tx = asSql(t);
  if (!isPartnerGameId(input.gameId) || !input.sourceRef) throw new PartnerError('invalid_request');
  // FOR SHARE: a block (which updates this row) waits for this play to commit, or this play sees the block.
  const [player] = await tx<{ partner_slug: string; environment: string; status: string; user_id: string | null }[]>`
    SELECT partner_slug, environment, status, user_id FROM partner_players WHERE id = ${input.playerId} FOR SHARE`;
  if (!player) throw new PartnerError('unknown_player');
  if (player.status !== 'active') throw new PartnerError('player_blocked');
  const [session] = await tx<{ state: string; live: boolean }[]>`
    SELECT state, session_expires_at > clock_timestamp() AS live
    FROM partner_sessions WHERE id = ${input.sessionId} AND player_id = ${input.playerId}`;
  if (!session || session.state !== 'redeemed' || !session.live) throw new PartnerError('session_ended');

  // One clock read: the start instant and its partner day can never straddle midnight.
  const [clock] = await tx<{ started_at: Date; day: string }[]>`
    SELECT t AS started_at, to_char((t AT TIME ZONE 'Asia/Tbilisi')::date, 'YYYY-MM-DD') AS day
    FROM (SELECT COALESCE(${input.at ?? null}::timestamptz, clock_timestamp()) AS t) c`;
  const day = clock.day;

  // A retried start finds its play whatever day it lands on: the source ref is serialised on its own.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-play:${player.partner_slug}:${player.environment}:${input.gameId}:${input.sourceRef}`}, 0))`;
  const [existing] = await tx<PlayRow[]>`
    SELECT * FROM partner_plays
    WHERE partner_slug = ${player.partner_slug} AND environment = ${player.environment}
      AND game_id = ${input.gameId} AND source_ref = ${input.sourceRef}`;
  if (existing) {
    if (existing.player_id !== input.playerId) throw new PartnerError('invalid_request');
    return toPlay(existing);
  }

  // FOR SHARE on the rules' version row until commit: a games or calendar save (FOR UPDATE on the same row) waits
  // for this play, so a lowered limit can never be exceeded by a start that read the old one.
  await tx`
    SELECT 1 FROM partner_config_versions
    WHERE partner_slug = ${player.partner_slug} AND environment = ${player.environment}
    FOR SHARE`;
  const [rule] = await tx<{ enabled: boolean; ready: boolean; default_limit: number; override_limit: number | null }[]>`
    SELECT g.enabled, g.ready, g.default_limit, o.plays_limit AS override_limit
    FROM partner_games g
    LEFT JOIN partner_limit_overrides o
      ON o.partner_slug = g.partner_slug AND o.environment = g.environment AND o.game_id = g.game_id
     AND o.date = ${day}::date
    WHERE g.partner_slug = ${player.partner_slug} AND g.environment = ${player.environment} AND g.game_id = ${input.gameId}`;
  if (!rule || !rule.enabled || !rule.ready) throw new PartnerError('game_not_available');
  const limit = rule.override_limit ?? rule.default_limit;

  // The conflict path locks the counter row and re-checks the limit on its latest version, so concurrent starts
  // can never exceed it; no row back means the day is used up (a zero limit never creates one).
  const [counter] = await tx<{ plays_used: number }[]>`
    INSERT INTO partner_quota_days (partner_slug, environment, player_id, game_id, partner_day, plays_used, updated_at)
    SELECT ${player.partner_slug}, ${player.environment}, ${input.playerId}::uuid, ${input.gameId}, ${day}::date, 1,
           clock_timestamp()
    WHERE ${limit}::int > 0
    ON CONFLICT (partner_slug, environment, player_id, game_id, partner_day)
    DO UPDATE SET plays_used = partner_quota_days.plays_used + 1, updated_at = clock_timestamp()
    WHERE partner_quota_days.plays_used < ${limit}::int
    RETURNING plays_used`;
  if (!counter) throw new PartnerError('quota_exhausted');
  const [play] = await tx<PlayRow[]>`
    INSERT INTO partner_plays
      (partner_slug, environment, player_id, session_id, game_id, partner_day, limit_snapshot, source_ref, started_at)
    VALUES (${player.partner_slug}, ${player.environment}, ${input.playerId}, ${input.sessionId}, ${input.gameId},
            ${day}::date, ${limit}, ${input.sourceRef}, ${clock.started_at})
    RETURNING *`;
  const reserved = toPlay(play);
  if (player.user_id) {
    recordPartnerEvent(t, {
      event: 'partner_play_started',
      userId: player.user_id,
      slug: reserved.partnerSlug,
      partnerEnvironment: reserved.environment,
      key: reserved.id,
      occurredAt: reserved.startedAt,
      properties: { game_id: reserved.gameId, partner_day: day, plays_used_today: counter.plays_used, plays_limit: limit },
    });
  }
  return reserved;
}

type PlayWithUser = PlayRow & { user_id: string | null };

function recordPlayEnd(t: TransactionSql, row: PlayWithUser, properties: Record<string, string | number | boolean | null | undefined>): void {
  if (!row.user_id) return;
  const play = toPlay(row);
  const end = play.state === 'finished' ? play.finishedAt : play.cancelledAt;
  recordPartnerEvent(t, {
    event: play.state === 'finished' ? 'partner_play_finished' : 'partner_play_cancelled',
    userId: row.user_id,
    slug: play.partnerSlug,
    partnerEnvironment: play.environment,
    key: play.id,
    occurredAt: end ?? undefined,
    properties: {
      game_id: play.gameId,
      partner_day: play.partnerDay,
      duration_ms: end ? Math.max(0, end.getTime() - play.startedAt.getTime()) : undefined,
      ...properties,
    },
  });
}

/**
 * Finishes a play with its score; idempotent (a repeat returns the play as first finished). A play cancelled
 * meanwhile (the player was blocked: no event, the play stays used; contract §5.5) is returned unchanged with state
 * 'cancelled': callers enqueue a score event only for state 'finished'. `opts.at` is when the play logically ended
 * (a deadline processed late), default the database clock. `opts.maxScore` replaces the game's fixed cap (ranked:
 * the maximum of the points table the match started on).
 */
export async function finishPlay(
  t: TransactionSql,
  playId: string,
  score: number,
  opts: { at?: Date; maxScore?: number; details?: PartnerPlayDetails } = {},
): Promise<PartnerPlay> {
  const tx = asSql(t);
  if (!Number.isInteger(score) || score < 0) throw new PartnerError('invalid_request', 'score must be a whole number >= 0');
  const [owner] = await tx<{ player_id: string }[]>`SELECT player_id FROM partner_plays WHERE id = ${playId}`;
  if (!owner) throw new PartnerError('not_found', 'Play not found');
  // Player first, then play (a block locks in the same order and cancels started plays): either the block sees
  // this play finished, or this finish sees the play cancelled.
  const [player] = await tx<{ status: string }[]>`
    SELECT status FROM partner_players WHERE id = ${owner.player_id} FOR SHARE`;
  const [row] = await tx<PlayRow[]>`SELECT * FROM partner_plays WHERE id = ${playId} FOR UPDATE`;
  if (row.state === 'finished') {
    if (row.score !== score) logger.warn({ playId, first: row.score, again: score }, 'Partner play finished twice with different scores');
    return toPlay(row);
  }
  if (row.state === 'cancelled') return toPlay(row);
  if (player?.status !== 'active') {
    const [cancelled] = await tx<PlayWithUser[]>`
      UPDATE partner_plays SET state = 'cancelled', cancelled_at = clock_timestamp()
      WHERE id = ${playId}
      RETURNING *, (SELECT user_id FROM partner_players WHERE id = player_id) AS user_id`;
    recordPlayEnd(t, cancelled, { reason: 'blocked', refunded: false });
    return toPlay(cancelled);
  }
  const max = opts.maxScore ?? PARTNER_GAME_MAX_SCORE[row.game_id];
  if (score > max) logger.error({ playId, gameId: row.game_id, score, max }, 'Partner play score above the game maximum; capped');
  const [finished] = await tx<PlayWithUser[]>`
    UPDATE partner_plays
    SET state = 'finished', score = ${Math.min(score, max)},
        finished_at = COALESCE(${opts.at ?? null}::timestamptz, clock_timestamp())
    WHERE id = ${playId}
    RETURNING *, (SELECT user_id FROM partner_players WHERE id = player_id) AS user_id`;
  const d = opts.details;
  recordPlayEnd(t, finished, {
    score: finished.score,
    max_score: max,
    end_cause: d?.endCause,
    outcome: d?.outcome,
    goal_margin: d?.goalMargin,
    opponent_kind: d?.opponentKind,
  });
  return toPlay(finished);
}

/**
 * Cancels a started play (no score event). `refund` returns the play to today's count of the day it started.
 * `reason` labels the cancellation in analytics (default: returned when refunded, else voided).
 */
export async function cancelPlay(
  t: TransactionSql,
  playId: string,
  opts: { refund: boolean; reason?: string },
): Promise<PartnerPlay> {
  const tx = asSql(t);
  const [row] = await tx<PlayRow[]>`SELECT * FROM partner_plays WHERE id = ${playId} FOR UPDATE`;
  if (!row) throw new PartnerError('not_found', 'Play not found');
  if (row.state === 'cancelled') return toPlay(row);
  if (row.state === 'finished') throw new PartnerError('play_not_active');
  const [cancelled] = await tx<PlayWithUser[]>`
    UPDATE partner_plays SET state = 'cancelled', cancelled_at = clock_timestamp(), refunded = ${opts.refund}
    WHERE id = ${playId}
    RETURNING *, (SELECT user_id FROM partner_players WHERE id = player_id) AS user_id`;
  recordPlayEnd(t, cancelled, { reason: opts.reason ?? (opts.refund ? 'returned' : 'voided'), refunded: opts.refund });
  if (opts.refund) {
    await tx`
      UPDATE partner_quota_days SET plays_used = plays_used - 1, updated_at = clock_timestamp()
      WHERE partner_slug = ${row.partner_slug} AND environment = ${row.environment} AND player_id = ${row.player_id}
        AND game_id = ${row.game_id} AND partner_day = ${toPlay(row).partnerDay}::date AND plays_used > 0`;
  }
  return toPlay(cancelled);
}

export interface DayGameRule {
  gameId: PartnerGameId;
  enabled: boolean;
  ready: boolean;
  playsLimit: number;
  playsUsed: number;
}

/** The partner day at `at` (default: the database clock) and the next Tbilisi midnight. */
export async function partnerDayNow(at?: Date): Promise<{ day: string; now: Date }> {
  const [row] = await sql<{ day: string; now: Date }[]>`
    SELECT to_char((t AT TIME ZONE 'Asia/Tbilisi')::date, 'YYYY-MM-DD') AS day, t AS now
    FROM (SELECT COALESCE(${at ?? null}::timestamptz, clock_timestamp()) AS t) c`;
  return row;
}

/** Every game's rule for one day with one player's plays used, in the partner's order (ranked first). */
export async function dayRulesForPlayer(
  partner: { slug: string; environment: string },
  playerId: string,
  day: string,
): Promise<DayGameRule[]> {
  const rows = await sql<{ game_id: PartnerGameId; enabled: boolean; ready: boolean; default_limit: number; override_limit: number | null; plays_used: number }[]>`
    SELECT g.game_id, g.enabled, g.ready, g.default_limit, o.plays_limit AS override_limit,
           COALESCE(q.plays_used, 0) AS plays_used
    FROM partner_games g
    LEFT JOIN partner_limit_overrides o
      ON o.partner_slug = g.partner_slug AND o.environment = g.environment AND o.game_id = g.game_id AND o.date = ${day}::date
    LEFT JOIN partner_quota_days q
      ON q.partner_slug = g.partner_slug AND q.environment = g.environment AND q.game_id = g.game_id
     AND q.partner_day = ${day}::date AND q.player_id = ${playerId}
    WHERE g.partner_slug = ${partner.slug} AND g.environment = ${partner.environment}
    ORDER BY (g.game_id = 'ranked') DESC, g.sort_order`;
  return rows.map((r) => ({
    gameId: r.game_id,
    enabled: r.enabled,
    ready: r.ready,
    playsLimit: r.override_limit ?? r.default_limit,
    playsUsed: r.plays_used,
  }));
}

export interface PartnerGameTile {
  gameId: PartnerGameId;
  playsLimit: number;
  playsUsed: number;
  playsLeft: number;
  maxScore: number | null;
  available: boolean;
  /** A started play not finished yet (left or reloaded midway): the tile reopens it even with no plays left. */
  inProgress: boolean;
}

export interface MeGamesResponse {
  partnerDay: string;
  resetsAt: string;
  games: PartnerGameTile[];
}

/** GET /partner/v1/me/games: enabled games with a limit today ("0 = off that day" hides the tile). */
export async function meGames(
  principal: { slug: string; environment: string; playerId: string },
  at?: Date,
): Promise<MeGamesResponse> {
  const { day, now } = await partnerDayNow(at);
  const rules = await dayRulesForPlayer(principal, principal.playerId, day);
  const showsRanked = rules.some((r) => r.gameId === 'ranked' && r.enabled && r.playsLimit > 0);
  const rankedMax = showsRanked ? await currentRankedMaxScore(principal) : null;
  // Sweepers settle abandoned plays within hours, so two days bounds the scan without missing one.
  const open = await sql<{ game_id: string }[]>`
    SELECT DISTINCT game_id FROM partner_plays
    WHERE player_id = ${principal.playerId} AND state = 'started'
      AND started_at > clock_timestamp() - interval '2 days'`;
  const inProgress = new Set(open.map((r) => r.game_id));
  return {
    partnerDay: day,
    resetsAt: nextPartnerMidnight(now).toISOString(),
    games: rules
      .filter((r) => r.enabled && r.playsLimit > 0)
      .map((r) => ({
        gameId: r.gameId,
        playsLimit: r.playsLimit,
        playsUsed: r.playsUsed,
        playsLeft: Math.max(0, r.playsLimit - r.playsUsed),
        maxScore: r.gameId === 'ranked' ? rankedMax : PARTNER_GAME_MAX_SCORE[r.gameId],
        available: r.ready,
        inProgress: inProgress.has(r.gameId),
      })),
  };
}
