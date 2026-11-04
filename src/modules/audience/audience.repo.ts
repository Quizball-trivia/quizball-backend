import { sql } from '../../db/index.js';

export interface DayRange { from: string; to: string }

const ELIGIBLE = (alias: string) => sql.unsafe(`NOT ${alias}.is_ai AND NOT ${alias}.is_seed AND NOT ${alias}.is_deleted
  AND ${alias}.deleted_at IS NULL AND ${alias}.partner_slug IS NULL AND coalesce(${alias}.role, 'user') NOT IN ('admin', 'partner_staff')`);

/**
 * audience.player_days rows in [from, to], each resolved to a person when read: a guest who has since signed up or
 * logged in counts as that member, and every member must still be eligible (not deleted, not staff/partner) — a
 * guest linked to an account that is no longer eligible is left out, like that account.
 */
const people = (r: DayRange) => sql`
  SELECT p.day, p.mode, p.plays, p.user_id, p.guest_id, rp.person
    FROM audience.player_days p
    LEFT JOIN guest_journeys gj
      ON gj.guest_id = (CASE WHEN p.ident ~ '^g:[0-9a-f]{8}-[0-9a-f]{4}-' THEN substr(p.ident, 3)::uuid END)
    LEFT JOIN users lu ON lu.id = gj.linked_user_id AND NOT lu.is_guest AND ${ELIGIBLE('lu')}
    CROSS JOIN LATERAL (SELECT CASE WHEN lu.id IS NOT NULL THEN 'u:' || lu.id::text ELSE p.ident END AS person) rp
    LEFT JOIN users mu ON mu.id = (CASE WHEN rp.person LIKE 'u:%' THEN substr(rp.person, 3)::uuid END)
   WHERE p.day BETWEEN ${r.from}::date AND ${r.to}::date
     AND (rp.person NOT LIKE 'u:%' OR (mu.id IS NOT NULL AND NOT mu.is_guest AND ${ELIGIBLE('mu')}))
     AND (gj.linked_user_id IS NULL OR lu.id IS NOT NULL)
`;

/** Accounts created in [from, to] Georgia days, same eligibility as audience.activity. */
const freshAccounts = (r: DayRange) => sql`
  SELECT u.id, u.country, coalesce(a.platform, 'unknown') AS platform
    FROM users u LEFT JOIN user_signup_attribution a ON a.user_id = u.id
   WHERE NOT u.is_guest AND ${ELIGIBLE('u')}
     AND u.created_at >= (${r.from}::date)::timestamp AT TIME ZONE 'Asia/Tbilisi'
     AND u.created_at < (${r.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi'
`;

export interface SummaryRow {
  active: number; registered: number; guests: number; plays: number; new_players: number; new_guests: number; returning: number;
}
export interface NewRegisteredRow { total: number; played: number; web: number; android: number; ios: number }
export interface CountryRow { country: string; active: number; registered: number; guests: number; new_registered: number }
export interface GameRow { mode: string; players: number; registered: number; guests: number; plays: number }
export interface TrendRow { day: string; active: number; registered: number; guests: number; counted: boolean }
export interface CoverageRow { first_complete_day: string | null; incomplete_days: number; refreshed_at: string | null }

export const audienceRepo = {
  async summary(r: DayRange): Promise<SummaryRow> {
    const [row] = await sql<SummaryRow[]>`
      WITH p AS (${people(r)}),
      persons AS (SELECT DISTINCT person FROM p),
      firsts AS (  -- a member's first day includes the days they played as a guest before signing up
        SELECT q.person, min(f.first_day) AS first_day
          FROM persons q
          CROSS JOIN LATERAL (
            SELECT q.person AS ident
            UNION ALL
            SELECT 'g:' || g.guest_id::text FROM guest_journeys g
             WHERE g.linked_user_id = (CASE WHEN q.person LIKE 'u:%' THEN substr(q.person, 3)::uuid END)
          ) ids
          JOIN audience.ident_first_day f ON f.ident = ids.ident
         GROUP BY q.person
      )
      SELECT count(DISTINCT p.person)::int AS active,
             count(DISTINCT p.person) FILTER (WHERE p.person LIKE 'u:%')::int AS registered,
             count(DISTINCT p.person) FILTER (WHERE p.person LIKE 'g:%')::int AS guests,
             coalesce(sum(p.plays), 0)::int AS plays,
             count(DISTINCT p.person) FILTER (WHERE f.first_day >= ${r.from}::date)::int AS new_players,
             count(DISTINCT p.person) FILTER (WHERE f.first_day >= ${r.from}::date AND p.person LIKE 'g:%')::int AS new_guests,
             count(DISTINCT p.person) FILTER (WHERE f.first_day < ${r.from}::date)::int AS returning
        FROM p LEFT JOIN firsts f ON f.person = p.person
    `;
    return row;
  },

  async newRegistered(r: DayRange): Promise<NewRegisteredRow> {
    const [row] = await sql<NewRegisteredRow[]>`
      WITH fresh AS (${freshAccounts(r)}),
      played AS (SELECT DISTINCT person FROM (${people(r)}) x WHERE x.person LIKE 'u:%')
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE ('u:' || f.id::text) IN (SELECT person FROM played))::int AS played,
             count(*) FILTER (WHERE f.platform = 'web')::int AS web,
             count(*) FILTER (WHERE f.platform = 'android')::int AS android,
             count(*) FILTER (WHERE f.platform = 'ios')::int AS ios
        FROM fresh f
    `;
    return row;
  },

  /** Countries of the people who played plus countries with new accounts, so signup-only countries still show. */
  async countries(r: DayRange, limit: number): Promise<CountryRow[]> {
    return sql<CountryRow[]>`
      WITH p AS (SELECT DISTINCT ON (person) person, user_id, guest_id FROM (${people(r)}) x ORDER BY person, user_id NULLS LAST),
      located AS (
        SELECT p.person,
               upper(coalesce(nullIf(mu.country, ''), nullIf(gj.country, ''), nullIf(gu.country, ''), '??')) AS country
          FROM p
          LEFT JOIN users mu ON mu.id = (CASE WHEN p.person LIKE 'u:%' THEN substr(p.person, 3)::uuid END)
          LEFT JOIN guest_journeys gj
            ON gj.guest_id = (CASE WHEN p.person LIKE 'g:%' AND p.guest_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-' THEN p.guest_id::uuid END)
          LEFT JOIN users gu ON p.person LIKE 'g:%' AND gu.id = p.user_id
      ),
      active AS (
        SELECT country, count(*)::int AS active,
               count(*) FILTER (WHERE person LIKE 'u:%')::int AS registered,
               count(*) FILTER (WHERE person LIKE 'g:%')::int AS guests
          FROM located GROUP BY country
      ),
      fresh AS (SELECT upper(coalesce(nullIf(country, ''), '??')) AS country, count(*)::int AS n FROM (${freshAccounts(r)}) f GROUP BY 1)
      SELECT coalesce(a.country, f.country) AS country, coalesce(a.active, 0) AS active, coalesce(a.registered, 0) AS registered,
             coalesce(a.guests, 0) AS guests, coalesce(f.n, 0) AS new_registered
        FROM active a FULL OUTER JOIN fresh f ON f.country = a.country
       ORDER BY coalesce(a.active, 0) DESC, coalesce(f.n, 0) DESC, 1
       LIMIT ${limit}
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

  /** One row per day in the range, zeros included; counted = false for a day that was never refreshed. */
  async trend(r: DayRange): Promise<TrendRow[]> {
    return sql<TrendRow[]>`
      WITH c AS (
        SELECT day, count(DISTINCT person)::int AS active,
               count(DISTINCT person) FILTER (WHERE person LIKE 'u:%')::int AS registered,
               count(DISTINCT person) FILTER (WHERE person LIKE 'g:%')::int AS guests
          FROM (${people(r)}) p GROUP BY day
      )
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day, coalesce(c.active, 0) AS active, coalesce(c.registered, 0) AS registered,
             coalesce(c.guests, 0) AS guests, EXISTS (SELECT 1 FROM audience.refresh_state s WHERE s.day = d::date) AS counted
        FROM generate_series(${r.from}::date, ${r.to}::date, interval '1 day') d
        LEFT JOIN c ON c.day = d::date
       ORDER BY d
    `;
  },

  /** How much of [start, lastDay] is final: incomplete_days = days never refreshed or refreshed before they ended. */
  async coverage(start: string, lastDay: string): Promise<CoverageRow> {
    const [row] = await sql<CoverageRow[]>`
      SELECT to_char((SELECT min(day) FROM audience.refresh_state WHERE complete), 'YYYY-MM-DD') AS first_complete_day,
             (SELECT count(*)::int FROM generate_series(${start}::date, ${lastDay}::date, interval '1 day') d
               WHERE NOT EXISTS (SELECT 1 FROM audience.refresh_state s WHERE s.day = d::date AND s.complete)) AS incomplete_days,
             (SELECT max(refreshed_at)::text FROM audience.refresh_state) AS refreshed_at
    `;
    return row;
  },

  /** Days in [from, to] that are not final yet (never refreshed, or refreshed before the day ended), newest first. */
  async incompleteDays(from: string, to: string, limit: number): Promise<string[]> {
    const rows = await sql<{ day: string }[]>`
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day
        FROM generate_series(${from}::date, ${to}::date, interval '1 day') d
       WHERE NOT EXISTS (SELECT 1 FROM audience.refresh_state s WHERE s.day = d::date AND s.complete)
       ORDER BY d DESC LIMIT ${limit}
    `;
    return rows.map((r) => r.day);
  },

  /** -1: another replica holds the lock; -2: already refreshed in the last 5 minutes (only when wait = false). */
  async refreshDays(from: string, to: string, wait = true): Promise<number> {
    const [row] = await sql<{ n: number }[]>`SELECT audience.refresh_days(${from}::date, ${to}::date, ${wait}) AS n`;
    return row?.n ?? 0;
  },
};
