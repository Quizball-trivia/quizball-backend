/**
 * ორშაბათობა history for the Events tab: past show nights (podcast episode number, date, podium, player count) and
 * the next one. Episodes are numbered after the podcast: the first show night (2026-11-23) was episode 301, and every
 * later completed show night is the next number. Bots, seed users, the host account and accounts that are deleted or
 * waiting for deletion never appear.
 */
import { z } from 'zod';
import { getOrLoadJson } from '../../core/json-cache.js';
import { sql } from '../../db/index.js';
import { SHOW_PACK_SLUGS } from './show-packs/show-pack.js';
import { wlHostRunWeek } from './wl-week.js';

/** Podcast episode number of the first show night. */
export const ORSHABATOBA_FIRST_EPISODE = 301;
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

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The next show night's date: today if it's Monday in Georgia and tonight's show hasn't finished yet, otherwise the
 * coming Monday.
 */
export function orshabatobaNextDate(nowMs: number, completedDates: ReadonlySet<string>): string {
  const monday = wlHostRunWeek(nowMs).eventDate;
  const todayGe = new Date(nowMs + 4 * 3_600_000).toISOString().slice(0, 10);
  return todayGe === monday && !completedDates.has(monday) ? monday : addDays(monday, 7);
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
    const recent = nights
      .map((n, i) => ({ ...n, episode: ORSHABATOBA_FIRST_EPISODE + i }))
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
    const counts = ids.length === 0 ? [] : await sql<Array<{ tournament_id: string; players: number }>>`
      SELECT e.tournament_id, count(*)::int AS players
      FROM wl_entries e JOIN users u ON u.id = e.user_id
      WHERE e.tournament_id = ANY(${sql.array(ids)}::uuid[]) AND u.is_ai = false AND u.is_seed = false
        AND u.is_deleted = false AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
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

    const completed = new Set(nights.map((n) => n.event_date));
    return {
      next: { episode: ORSHABATOBA_FIRST_EPISODE + nights.length, event_date: orshabatobaNextDate(nowMs, completed) },
      editions,
    };
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
  const index = episode - ORSHABATOBA_FIRST_EPISODE;
  if (!Number.isInteger(index) || index < 0) return null;
  const board = await getOrLoadJson(`wl:orshabatoba:board:${episode}`, CACHE_TTL_SECONDS, async () => {
    const [night] = await sql<Array<{ id: string; event_date: string; host_email: string | null }>>`
      SELECT id, config->>'event_date' AS event_date, lower(config->>'host_email') AS host_email
      FROM wl_tournaments
      WHERE config->>'event_slug' = ${SLUG} AND status = 'completed' AND config ? 'event_date'
      ORDER BY config->>'event_date' ASC, created_at ASC
      OFFSET ${index} LIMIT 1
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
