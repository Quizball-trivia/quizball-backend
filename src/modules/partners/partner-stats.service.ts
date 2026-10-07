/** The Freecroco overview in the CMS (internal API §2): players, plays, ranked and score delivery for a range of
 *  partner days (Asia/Tbilisi), for this deploy's environment only. */

import { z } from 'zod';
import { sql } from '../../db/index.js';
import type { PartnerConfig } from './partner-config.js';
import { daySchema } from './partner-admin.service.js';
import { PartnerError } from './partner-errors.js';
import { addDays, PARTNER_GAME_IDS, type PartnerGameId } from './partner-games.js';
import { partnerDayNow } from './partner-quota.service.js';

/** The longest range one overview may cover, in days (both ends included). */
export const STATS_MAX_RANGE_DAYS = 92;
export const STATS_DEFAULT_RANGE_DAYS = 14;

export const statsQuerySchema = z.object({ from: daySchema.optional(), to: daySchema.optional() });
export type StatsQuery = z.infer<typeof statsQuerySchema>;

export interface PartnerDayStats {
  day: string;
  newPlayers: number;
  /** Players who started at least one play that day. */
  activePlayers: number;
  playsStarted: number;
  playsFinished: number;
  /** Sum of the scores of that day's events Freecroco has accepted. */
  pointsSent: number;
}

export interface PartnerGameStats {
  gameId: PartnerGameId;
  plays: number;
  finished: number;
  averageScore: number | null;
  maxScore: number | null;
  uniquePlayers: number;
}

export interface PartnerStats {
  from: string;
  to: string;
  today: string;
  totals: {
    playersEver: number;
    newPlayers: number;
    activeToday: number;
    activeYesterday: number;
    activeLast7Days: number;
    activeInRange: number;
  };
  todayStats: PartnerDayStats;
  yesterdayStats: PartnerDayStats;
  daily: PartnerDayStats[];
  games: PartnerGameStats[];
  ranked: {
    /** Ranked plays reserved (a queue join each). */
    plays: number;
    matches: number;
    /** Matches between two Freecroco players. */
    vsPlayers: number;
    /** Matches against a bot (the only other kind in the partner pool). */
    vsBots: number;
    settled: number;
    cancelled: number;
    /** Cancelled plays given back to the player's daily allowance. */
    returned: number;
    /** Still searching or in a match. */
    open: number;
  };
  delivery: {
    /** Events for plays finished in the range, by their current status. */
    sent: number;
    pending: number;
    dead: number;
    /** Right now, whatever the range. */
    pendingNow: number;
    deadNow: number;
    oldestPendingSeconds: number | null;
  };
}

type Partner = Pick<PartnerConfig, 'slug' | 'environment'>;

async function dailySeries(partner: Partner, from: string, to: string): Promise<PartnerDayStats[]> {
  const { slug, environment } = partner;
  // Day bounds are Tbilisi midnights, so the timestamp ranges stay on the (…, created_at / occurred_at) indexes.
  const rows = await sql<{
    day: string; new_players: number; active: number; started: number; finished: number; points: string;
  }[]>`
    WITH days AS (
      SELECT d::date AS day FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS d
    ), plays AS (
      SELECT partner_day AS day, count(*)::int AS started,
             count(*) FILTER (WHERE state = 'finished')::int AS finished,
             count(DISTINCT player_id)::int AS active
      FROM partner_plays
      WHERE partner_slug = ${slug} AND environment = ${environment}
        AND partner_day BETWEEN ${from}::date AND ${to}::date
      GROUP BY partner_day
    ), players AS (
      SELECT (created_at AT TIME ZONE 'Asia/Tbilisi')::date AS day, count(*)::int AS n
      FROM partner_players
      WHERE partner_slug = ${slug} AND environment = ${environment} AND user_id IS NOT NULL
        AND created_at >= ${from}::date::timestamp AT TIME ZONE 'Asia/Tbilisi'
        AND created_at < (${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi'
      GROUP BY 1
    ), points AS (
      SELECT (occurred_at AT TIME ZONE 'Asia/Tbilisi')::date AS day, sum(score)::bigint AS points
      FROM partner_score_events
      WHERE partner_slug = ${slug} AND environment = ${environment} AND status = 'sent'
        AND occurred_at >= ${from}::date::timestamp AT TIME ZONE 'Asia/Tbilisi'
        AND occurred_at < (${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi'
      GROUP BY 1
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(pl.n, 0) AS new_players, coalesce(p.active, 0) AS active,
           coalesce(p.started, 0) AS started, coalesce(p.finished, 0) AS finished,
           coalesce(pt.points, 0)::text AS points
    FROM days d
    LEFT JOIN plays p ON p.day = d.day
    LEFT JOIN players pl ON pl.day = d.day
    LEFT JOIN points pt ON pt.day = d.day
    ORDER BY d.day`;
  return rows.map((r) => ({
    day: r.day,
    newPlayers: r.new_players,
    activePlayers: r.active,
    playsStarted: r.started,
    playsFinished: r.finished,
    pointsSent: Number(r.points),
  }));
}

async function totals(partner: Partner, from: string, to: string, today: string): Promise<PartnerStats['totals']> {
  const { slug, environment } = partner;
  const yesterday = addDays(today, -1);
  const weekStart = addDays(today, -6);
  const [row] = await sql<PartnerStats['totals'][]>`
    SELECT
      (SELECT count(*) FROM partner_players
        WHERE partner_slug = ${slug} AND environment = ${environment} AND user_id IS NOT NULL)::int AS "playersEver",
      (SELECT count(*) FROM partner_players
        WHERE partner_slug = ${slug} AND environment = ${environment} AND user_id IS NOT NULL
          AND created_at >= ${from}::date::timestamp AT TIME ZONE 'Asia/Tbilisi'
          AND created_at < (${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi')::int AS "newPlayers",
      (SELECT count(DISTINCT player_id) FROM partner_plays
        WHERE partner_slug = ${slug} AND environment = ${environment} AND partner_day = ${today}::date)::int AS "activeToday",
      (SELECT count(DISTINCT player_id) FROM partner_plays
        WHERE partner_slug = ${slug} AND environment = ${environment} AND partner_day = ${yesterday}::date)::int AS "activeYesterday",
      (SELECT count(DISTINCT player_id) FROM partner_plays
        WHERE partner_slug = ${slug} AND environment = ${environment}
          AND partner_day BETWEEN ${weekStart}::date AND ${today}::date)::int AS "activeLast7Days",
      (SELECT count(DISTINCT player_id) FROM partner_plays
        WHERE partner_slug = ${slug} AND environment = ${environment}
          AND partner_day BETWEEN ${from}::date AND ${to}::date)::int AS "activeInRange"`;
  return row;
}

async function games(partner: Partner, from: string, to: string): Promise<PartnerGameStats[]> {
  const rows = await sql<{
    game_id: PartnerGameId; plays: number; finished: number; avg_score: number | null; max_score: number | null; players: number;
  }[]>`
    SELECT game_id, count(*)::int AS plays, count(*) FILTER (WHERE state = 'finished')::int AS finished,
           round(avg(score) FILTER (WHERE state = 'finished'), 1)::float8 AS avg_score,
           max(score) FILTER (WHERE state = 'finished') AS max_score,
           count(DISTINCT player_id)::int AS players
    FROM partner_plays
    WHERE partner_slug = ${partner.slug} AND environment = ${partner.environment}
      AND partner_day BETWEEN ${from}::date AND ${to}::date
    GROUP BY game_id`;
  const byGame = new Map(rows.map((r) => [r.game_id, r]));
  return PARTNER_GAME_IDS.map((gameId) => {
    const r = byGame.get(gameId);
    return {
      gameId,
      plays: r?.plays ?? 0,
      finished: r?.finished ?? 0,
      averageScore: r?.avg_score ?? null,
      maxScore: r?.max_score ?? null,
      uniquePlayers: r?.players ?? 0,
    };
  });
}

async function ranked(partner: Partner, from: string, to: string): Promise<PartnerStats['ranked']> {
  // A partner match has one entry per Freecroco player in it; a bot has none, so one entry means a bot match.
  // Sides are counted over all of the match's entries, since the two players' plays can fall on either side of
  // midnight.
  const [row] = await sql<PartnerStats['ranked'][]>`
    WITH e AS (
      SELECT e.state, e.match_id, e.refunded
      FROM partner_plays p
      JOIN partner_ranked_entries e ON e.play_id = p.id
      WHERE p.partner_slug = ${partner.slug} AND p.environment = ${partner.environment} AND p.game_id = 'ranked'
        AND p.partner_day BETWEEN ${from}::date AND ${to}::date
    ), m AS (
      SELECT y.match_id, count(*) AS sides
      FROM partner_ranked_entries y
      WHERE y.match_id IN (SELECT match_id FROM e WHERE match_id IS NOT NULL)
      GROUP BY y.match_id
    ), es AS (
      SELECT count(*)::int AS plays,
             count(*) FILTER (WHERE state = 'settled')::int AS settled,
             count(*) FILTER (WHERE state = 'cancelled')::int AS cancelled,
             count(*) FILTER (WHERE refunded)::int AS returned,
             count(*) FILTER (WHERE state IN ('searching', 'playing'))::int AS open
      FROM e
    ), ms AS (
      SELECT count(*)::int AS matches,
             count(*) FILTER (WHERE sides >= 2)::int AS "vsPlayers",
             count(*) FILTER (WHERE sides = 1)::int AS "vsBots"
      FROM m
    )
    SELECT es.plays, ms.matches, ms."vsPlayers", ms."vsBots", es.settled, es.cancelled, es.returned, es.open
    FROM es, ms`;
  return row;
}

async function delivery(partner: Partner, from: string, to: string): Promise<PartnerStats['delivery']> {
  const { slug, environment } = partner;
  const [row] = await sql<PartnerStats['delivery'][]>`
    SELECT r.sent, r.pending, r.dead, n.pending AS "pendingNow", d.dead AS "deadNow", n.oldest AS "oldestPendingSeconds"
    FROM (
      SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent,
             count(*) FILTER (WHERE status = 'pending')::int AS pending,
             count(*) FILTER (WHERE status = 'dead')::int AS dead
      FROM partner_score_events
      WHERE partner_slug = ${slug} AND environment = ${environment}
        AND occurred_at >= ${from}::date::timestamp AT TIME ZONE 'Asia/Tbilisi'
        AND occurred_at < (${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi'
    ) r,
    (
      -- Aged from the start of its retry window, as the status endpoint does.
      SELECT count(*)::int AS pending,
             CASE WHEN count(*) > 0
               THEN greatest(0, floor(extract(epoch FROM now() - min(coalesce(revived_at, created_at)))))::int
             END AS oldest
      FROM partner_score_events
      WHERE partner_slug = ${slug} AND environment = ${environment} AND status = 'pending'
    ) n,
    (
      SELECT count(*)::int AS dead FROM partner_score_events
      WHERE partner_slug = ${slug} AND environment = ${environment} AND status = 'dead'
    ) d`;
  return row;
}

const STATS_CACHE_MS = 60_000;
const statsCache = new Map<string, { at: number; value: Promise<PartnerStats> }>();

export function clearPartnerStatsCache(): void {
  statsCache.clear();
}

/** Cached for a minute per range and shared by concurrent requests: a dashboard refresh must never hit the DB. */
export async function getPartnerStats(config: PartnerConfig, query: StatsQuery, at?: Date): Promise<PartnerStats> {
  if (at) return computePartnerStats(config, query, at);
  const key = `${config.slug}:${config.environment}:${query.from ?? ''}:${query.to ?? ''}`;
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < STATS_CACHE_MS) return hit.value;
  const value = computePartnerStats(config, query);
  statsCache.set(key, { at: Date.now(), value });
  value.catch(() => statsCache.delete(key));
  if (statsCache.size > 100) statsCache.delete(statsCache.keys().next().value!);
  return value;
}

async function computePartnerStats(config: PartnerConfig, query: StatsQuery, at?: Date): Promise<PartnerStats> {
  const { day: today } = await partnerDayNow(at);
  const to = query.to ?? (query.from ? addDays(query.from, STATS_DEFAULT_RANGE_DAYS - 1) : today);
  const from = query.from ?? addDays(to, -(STATS_DEFAULT_RANGE_DAYS - 1));
  if (from > to || addDays(from, STATS_MAX_RANGE_DAYS - 1) < to) {
    throw new PartnerError('invalid_request', `from must be on or before to, at most ${STATS_MAX_RANGE_DAYS} days in all`);
  }
  const partner = { slug: config.slug, environment: config.environment };
  const yesterday = addDays(today, -1);
  // One after another: a stats load holds one pool connection, never six, so gameplay is never starved.
  const daily = await dailySeries(partner, from, to);
  const recent = await dailySeries(partner, yesterday, today);
  const sums = await totals(partner, from, to, today);
  const perGame = await games(partner, from, to);
  const rankedStats = await ranked(partner, from, to);
  const deliveryStats = await delivery(partner, from, to);
  return {
    from,
    to,
    today,
    totals: sums,
    todayStats: recent[1],
    yesterdayStats: recent[0],
    daily,
    games: perGame,
    ranked: rankedStats,
    delivery: deliveryStats,
  };
}
