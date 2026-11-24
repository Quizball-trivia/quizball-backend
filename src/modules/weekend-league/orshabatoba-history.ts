/**
 * ორშაბათობა history for the Events tab: past show nights (podcast episode number, date, podium, player count) and
 * the next one. Episodes are numbered after the weekly podcast, by date: Monday 2026-11-23 is episode 301 and each
 * Monday after it is one more, so a number never changes (deleting or skipping a show night doesn't renumber others). Bots, seed users, the host account and accounts that are deleted or
 * waiting for deletion never appear.
 */
import { z } from 'zod';
import { getOrLoadJson } from '../../core/json-cache.js';
import { sql } from '../../db/index.js';
import { SHOW_PACK_SLUGS } from './show-packs/show-pack.js';
import { wlHostRunWeek } from './wl-week.js';

/** Podcast episode number of the first show night, and its Monday. */
export const ORSHABATOBA_FIRST_EPISODE = 301;
export const ORSHABATOBA_FIRST_DATE = '2026-11-23';
const SLUG = SHOW_PACK_SLUGS[0];
/** Short: a finished show night should show up on the Events tab within a minute. */
const CACHE_TTL_SECONDS = 60;
const MAX_EDITIONS = 20;
const DAY_MS = 86_400_000;

const podiumRowSchema = z.object({
  rank: z.number().int(),
  nickname: z.string().nullable(),
  avatar_url: z.string().nullable(),
  points: z.number().int(),
});
export const orshabatobaHistoryResponseSchema = z.object({
  next: z.object({ episode: z.number().int(), event_date: z.string() }),
  editions: z.array(z.object({
    episode: z.number().int(),
    event_date: z.string(),
    players: z.number().int(),
    podium: z.array(podiumRowSchema),
  })),
});
export type OrshabatobaHistoryResponse = z.infer<typeof orshabatobaHistoryResponseSchema>;

/** Podcast episode of a show Monday (YYYY-MM-DD): one per week from episode 301 on 2026-11-23. */
export function orshabatobaEpisode(eventDate: string): number {
  const weeks = Math.round((Date.parse(`${eventDate}T00:00:00Z`) - Date.parse(`${ORSHABATOBA_FIRST_DATE}T00:00:00Z`)) / (7 * DAY_MS));
  return ORSHABATOBA_FIRST_EPISODE + weeks;
}
/** Show Monday of an episode number (inverse of orshabatobaEpisode). */
export function orshabatobaEpisodeDate(episode: number): string {
  return addDays(ORSHABATOBA_FIRST_DATE, (episode - ORSHABATOBA_FIRST_EPISODE) * 7);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The next show night's date: today if it's Monday in Georgia and tonight's show hasn't finished (or been cancelled),
 * otherwise the coming Monday — the same choice the orchestrator makes when it opens registration.
 */
export function orshabatobaNextDate(nowMs: number, finishedDates: ReadonlySet<string>): string {
  const monday = wlHostRunWeek(nowMs).eventDate;
  const todayGe = new Date(nowMs + 4 * 3_600_000).toISOString().slice(0, 10);
  return todayGe === monday && !finishedDates.has(monday) ? monday : addDays(monday, 7);
}

export async function orshabatobaHistory(nowMs = Date.now()): Promise<OrshabatobaHistoryResponse> {
  return getOrLoadJson('wl:orshabatoba:history', CACHE_TTL_SECONDS, async () => {
    // Every completed show night, oldest first, so its position gives the episode number.
    const nights = await sql<Array<{ id: string; event_date: string; host_email: string | null }>>`
      SELECT id, config->>'event_date' AS event_date, lower(config->>'host_email') AS host_email
      FROM wl_tournaments
      WHERE config->>'event_slug' = ${SLUG} AND status = 'completed' AND config ? 'event_date'
      ORDER BY config->>'event_date' ASC, created_at ASC
    `;
    // One per Monday (the latest row, if a date was ever run twice), so an episode number is never repeated.
    const perDate = [...new Map(nights.map((n) => [n.event_date, n])).values()];
    const recent = perDate
      .map((n) => ({ ...n, episode: orshabatobaEpisode(n.event_date) }))
      .slice(-MAX_EDITIONS)
      .reverse();
    const ids = recent.map((n) => n.id);

    const rows = ids.length === 0 ? [] : await sql<Array<{
      tournament_id: string; nickname: string | null; avatar_url: string | null; points: number; email: string | null;
    }>>`
      SELECT e.tournament_id, u.nickname, u.avatar_url, lower(u.email) AS email,
             COALESCE((SELECT sum(g.score) FROM wl_game_results g
                       WHERE g.tournament_id = e.tournament_id AND g.user_id = e.user_id), 0)::int AS points
      FROM wl_entries e
      JOIN users u ON u.id = e.user_id
      WHERE e.tournament_id = ANY(${sql.array(ids)}::uuid[]) AND e.final_rank IS NOT NULL
        AND u.is_ai = false AND u.is_seed = false
        AND u.is_deleted = false AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
      ORDER BY e.tournament_id, e.final_rank ASC
    `;
    // Same people as the boards: real players, without the host.
    const counts = ids.length === 0 ? [] : await sql<Array<{ tournament_id: string; players: number }>>`
      SELECT e.tournament_id, count(*)::int AS players
      FROM wl_entries e
      JOIN wl_tournaments t ON t.id = e.tournament_id
      JOIN users u ON u.id = e.user_id
      WHERE e.tournament_id = ANY(${sql.array(ids)}::uuid[]) AND u.is_ai = false AND u.is_seed = false
        AND u.is_deleted = false AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
        AND lower(COALESCE(u.email, '')) IS DISTINCT FROM lower(t.config->>'host_email')
      GROUP BY e.tournament_id
    `;
    const players = new Map(counts.map((c) => [c.tournament_id, c.players]));

    const editions = recent.map((n) => {
      // Real players only, in final order, without the host; re-ranked 1-2-3.
      const podium = rows
        .filter((r) => r.tournament_id === n.id && !(n.host_email && r.email === n.host_email))
        .slice(0, 3)
        .map((r, i) => ({ rank: i + 1, nickname: r.nickname, avatar_url: r.avatar_url, points: r.points }));
      return { episode: n.episode, event_date: n.event_date, players: players.get(n.id) ?? 0, podium };
    });

    // Finished = completed, cancelled or voided (as the orchestrator counts it).
    const finished = await sql<Array<{ event_date: string }>>`
      SELECT config->>'event_date' AS event_date FROM wl_tournaments
      WHERE config->>'event_slug' = ${SLUG} AND status IN ('completed', 'cancelled', 'voided') AND config ? 'event_date'
    `;
    const nextDate = orshabatobaNextDate(nowMs, new Set(finished.map((f) => f.event_date)));
    return { next: { episode: orshabatobaEpisode(nextDate), event_date: nextDate }, editions };
  });
}

export const orshabatobaLeaderboardResponseSchema = z.object({
  episode: z.number().int(),
  event_date: z.string(),
  rows: z.array(podiumRowSchema.extend({ is_you: z.boolean() })),
});
export type OrshabatobaLeaderboardResponse = z.infer<typeof orshabatobaLeaderboardResponseSchema>;

/**
 * One past show night's full final leaderboard (real players only, host left out, ranked 1..n), or null for an
 * unknown episode. `is_you` marks the caller's row; user ids never leave the server.
 */
export async function orshabatobaLeaderboard(episode: number, userId: string | null): Promise<OrshabatobaLeaderboardResponse | null> {
  if (!Number.isInteger(episode) || episode < ORSHABATOBA_FIRST_EPISODE) return null;
  const eventDate = orshabatobaEpisodeDate(episode);
  const board = await getOrLoadJson(`wl:orshabatoba:board:${episode}`, CACHE_TTL_SECONDS, async () => {
    const [night] = await sql<Array<{ id: string; event_date: string; host_email: string | null }>>`
      SELECT id, config->>'event_date' AS event_date, lower(config->>'host_email') AS host_email
      FROM wl_tournaments
      WHERE config->>'event_slug' = ${SLUG} AND status = 'completed' AND config->>'event_date' = ${eventDate}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (!night) return null;
    const rows = await sql<Array<{ user_id: string; nickname: string | null; avatar_url: string | null; email: string | null; points: number }>>`
      SELECT e.user_id, u.nickname, u.avatar_url, lower(u.email) AS email,
             COALESCE((SELECT sum(g.score) FROM wl_game_results g
                       WHERE g.tournament_id = e.tournament_id AND g.user_id = e.user_id), 0)::int AS points
      FROM wl_entries e
      JOIN users u ON u.id = e.user_id
      WHERE e.tournament_id = ${night.id} AND e.final_rank IS NOT NULL AND u.is_ai = false AND u.is_seed = false
        AND u.is_deleted = false AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
      ORDER BY e.final_rank ASC
    `;
    return {
      event_date: night.event_date,
      rows: rows
        .filter((r) => !(night.host_email && r.email === night.host_email))
        .map((r, i) => ({ rank: i + 1, user_id: r.user_id, nickname: r.nickname, avatar_url: r.avatar_url, points: r.points })),
    };
  });
  if (!board) return null;
  return {
    episode,
    event_date: board.event_date,
    rows: board.rows.map(({ user_id, ...r }) => ({ ...r, is_you: user_id === userId })),
  };
}
