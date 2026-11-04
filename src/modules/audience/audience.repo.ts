import { sql } from '../../db/index.js';

export interface DayRange { from: string; to: string }

/**
 * audience.player_days rows in [from, to], with each person resolved at read time: a guest who has since signed up
 * or logged in (guest_journeys.linked_user_id) counts as that member, so later conversions never double-count.
 */
const people = (r: DayRange) => sql`
  SELECT p.day, p.mode, p.plays, p.user_id, p.guest_id,
         CASE WHEN p.ident LIKE 'g:%' AND gj.linked_user_id IS NOT NULL THEN 'u:' || gj.linked_user_id::text ELSE p.ident END AS person
    FROM audience.player_days p
    LEFT JOIN guest_journeys gj ON p.ident LIKE 'g:%' AND gj.guest_id::text = substr(p.ident, 3)
   WHERE p.day BETWEEN ${r.from}::date AND ${r.to}::date
`;

export interface SummaryRow {
  active: number; registered: number; guests: number; plays: number; new_players: number; new_guests: number; returning: number;
}
export interface NewRegisteredRow { total: number; played: number; web: number; android: number; ios: number }
export interface CountryRow { country: string; active: number; registered: number; guests: number; new_registered: number }
export interface GameRow { mode: string; players: number; registered: number; guests: number; plays: number }
export interface TrendRow { day: string; active: number; registered: number; guests: number }
export interface CoverageRow { first_day: string | null; last_day: string | null; refreshed_at: string | null }

export const audienceRepo = {
  async summary(r: DayRange): Promise<SummaryRow> {
    const [row] = await sql<SummaryRow[]>`
      WITH p AS (${people(r)}),
      firsts AS (
        SELECT pp.person, min(pp.day) AS first_day
          FROM (${people({ from: '2026-01-01', to: r.to })}) pp
         WHERE pp.person IN (SELECT person FROM p)
         GROUP BY pp.person
      )
      SELECT count(DISTINCT p.person)::int AS active,
             count(DISTINCT p.person) FILTER (WHERE p.person LIKE 'u:%')::int AS registered,
             count(DISTINCT p.person) FILTER (WHERE p.person LIKE 'g:%')::int AS guests,
             coalesce(sum(p.plays), 0)::int AS plays,
             count(DISTINCT p.person) FILTER (WHERE f.first_day >= ${r.from}::date)::int AS new_players,
             count(DISTINCT p.person) FILTER (WHERE f.first_day >= ${r.from}::date AND p.person LIKE 'g:%')::int AS new_guests,
             count(DISTINCT p.person) FILTER (WHERE f.first_day < ${r.from}::date)::int AS returning
        FROM p JOIN firsts f ON f.person = p.person
    `;
    return row;
  },

  /** Accounts created in the range (same eligibility as audience.activity), and how many of them played. */
  async newRegistered(r: DayRange): Promise<NewRegisteredRow> {
    const [row] = await sql<NewRegisteredRow[]>`
      WITH fresh AS (
        SELECT u.id, coalesce(a.platform, 'unknown') AS platform
          FROM users u LEFT JOIN user_signup_attribution a ON a.user_id = u.id
         WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_deleted AND NOT u.is_guest AND u.deleted_at IS NULL
           AND u.partner_slug IS NULL AND coalesce(u.role, 'user') NOT IN ('admin', 'partner_staff')
           AND u.created_at >= (${r.from}::date)::timestamp AT TIME ZONE 'Asia/Tbilisi'
           AND u.created_at < (${r.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi'
      )
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM audience.player_days pd WHERE pd.ident = 'u:' || f.id::text
                 AND pd.day BETWEEN ${r.from}::date AND ${r.to}::date))::int AS played,
             count(*) FILTER (WHERE platform = 'web')::int AS web,
             count(*) FILTER (WHERE platform = 'android')::int AS android,
             count(*) FILTER (WHERE platform = 'ios')::int AS ios
        FROM fresh f
    `;
    return row;
  },

  async countries(r: DayRange, limit: number): Promise<CountryRow[]> {
    return sql<CountryRow[]>`
      WITH p AS (SELECT DISTINCT ON (person) person, user_id, guest_id FROM (${people(r)}) x ORDER BY person, user_id NULLS LAST),
      located AS (
        SELECT p.person,
               upper(coalesce(nullIf(CASE WHEN p.person LIKE 'u:%' THEN mu.country END, ''),
                              nullIf(gj.country, ''), nullIf(gu.country, ''), '??')) AS country
          FROM p
          LEFT JOIN users mu ON p.person LIKE 'u:%' AND mu.id::text = substr(p.person, 3)
          LEFT JOIN guest_journeys gj ON p.person LIKE 'g:%' AND gj.guest_id::text = p.guest_id
          LEFT JOIN users gu ON p.person LIKE 'g:%' AND gu.id = p.user_id
      ),
      fresh AS (
        SELECT upper(coalesce(nullIf(u.country, ''), '??')) AS country, count(*)::int AS n
          FROM users u
         WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_deleted AND NOT u.is_guest AND u.deleted_at IS NULL
           AND u.partner_slug IS NULL AND coalesce(u.role, 'user') NOT IN ('admin', 'partner_staff')
           AND u.created_at >= (${r.from}::date)::timestamp AT TIME ZONE 'Asia/Tbilisi'
           AND u.created_at < (${r.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi'
         GROUP BY 1
      )
      SELECT l.country, count(*)::int AS active,
             count(*) FILTER (WHERE l.person LIKE 'u:%')::int AS registered,
             count(*) FILTER (WHERE l.person LIKE 'g:%')::int AS guests,
             coalesce(max(f.n), 0)::int AS new_registered
        FROM located l LEFT JOIN fresh f ON f.country = l.country
       GROUP BY l.country ORDER BY active DESC, l.country LIMIT ${limit}
    `;
  },

  async games(r: DayRange, limit: number): Promise<GameRow[]> {
    return sql<GameRow[]>`
      SELECT mode, count(DISTINCT person)::int AS players,
             count(DISTINCT person) FILTER (WHERE person LIKE 'u:%')::int AS registered,
             count(DISTINCT person) FILTER (WHERE person LIKE 'g:%')::int AS guests,
             sum(plays)::int AS plays
        FROM (${people(r)}) p
       GROUP BY mode ORDER BY players DESC, mode LIMIT ${limit}
    `;
  },

  async trend(r: DayRange): Promise<TrendRow[]> {
    return sql<TrendRow[]>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, count(DISTINCT person)::int AS active,
             count(DISTINCT person) FILTER (WHERE person LIKE 'u:%')::int AS registered,
             count(DISTINCT person) FILTER (WHERE person LIKE 'g:%')::int AS guests
        FROM (${people(r)}) p
       GROUP BY day ORDER BY day
    `;
  },

  async coverage(): Promise<CoverageRow> {
    const [row] = await sql<CoverageRow[]>`
      SELECT to_char(min(day), 'YYYY-MM-DD') AS first_day, to_char(max(day), 'YYYY-MM-DD') AS last_day,
             max(refreshed_at)::text AS refreshed_at
        FROM audience.refresh_state
    `;
    return row;
  },

  /** Days in [from, to] that were never refreshed, oldest first. */
  async missingDays(from: string, to: string, limit: number): Promise<string[]> {
    const rows = await sql<{ day: string }[]>`
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day
        FROM generate_series(${from}::date, ${to}::date, interval '1 day') d
       WHERE NOT EXISTS (SELECT 1 FROM audience.refresh_state s WHERE s.day = d::date)
       ORDER BY d DESC LIMIT ${limit}
    `;
    return rows.map((r) => r.day);
  },

  /** -1 when another replica is refreshing right now (wait = false). */
  async refreshDays(from: string, to: string, wait = true): Promise<number> {
    const [row] = await sql<{ n: number }[]>`SELECT audience.refresh_days(${from}::date, ${to}::date, ${wait}) AS n`;
    return row?.n ?? 0;
  },
};
