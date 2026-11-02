import { sql } from '../../db/index.js';

/** All stats run in Asia/Tbilisi days — the convention every Quizball report uses. */
const TZ = 'Asia/Tbilisi';

export interface AnalyticsTotalsRow {
  registered: number;
  playing_guests: number;
  total_users: number;
  guests_played_30d: number;
  guests_converted_30d: number;
}

export interface ActivesRow {
  dau: number;
  wau: number;
  mau: number;
}

export interface DayCountRow {
  day: string;
  count: number;
}

export interface GamesPerDayRow {
  day: string;
  mode: string;
  games: number;
}

export interface CountryRow {
  country: string;
  registered: number;
  guests: number;
  total: number;
}


/** Daily-game run tables sharing the (user_id, guest_id, created_at) shape —
 *  the newer dailies (Buscaminas, Minuto, Pistas, ...) live here. Missing them
 *  undercounted MAU by ~60% (2026-10-31 audit: 5,961 -> 15,493). */
const DUAL_IDENTITY_RUN_TABLES = [
  'ultimo_runs', 'name_chain_runs', 'buscaminas_runs', 'minuto_runs',
  'pistas_runs', 'conexiones_runs', 'dato_falso_runs', 'codenames_runs',
  'tenable_runs', 'football_race_runs', 'darts501_runs', 'grid_daily_runs',
  'shared_player_runs',
] as const;

/** The timeline event type for a daily run table: 'minuto_runs' → 'minuto'. */
export const dailyRunType = (table: (typeof DUAL_IDENTITY_RUN_TABLES)[number]) => table.replace(/_runs$/, '');

/**
 * Person-timeline rows for every daily run table (Ultimo, Name Chain, Minuto,
 * Buscaminas, Pistas, …) — all share (user_id, guest_id, score, done, created_at).
 * Starts with UNION ALL; splice after another branch.
 */
function dailyRunTimeline(column: 'user_id' | 'guest_id', id: string) {
  return DUAL_IDENTITY_RUN_TABLES.reduce(
    (acc, table) => sql`${acc}
        UNION ALL
        SELECT r.created_at, ${dailyRunType(table)}::text, jsonb_build_object('score', r.score, 'done', r.done)
        FROM ${sql(table)} r WHERE ${sql('r.' + column)} = ${id}`,
    sql``,
  );
}

function dualRunIdentityUnions(interval: string) {
  return DUAL_IDENTITY_RUN_TABLES.reduce(
    (acc, table) => sql`${acc}
      UNION ALL
      SELECT coalesce('u:' || r.user_id::text, 'g:' || r.guest_id::text), r.created_at
      FROM ${sql(table)} r
      WHERE r.created_at > now() - ${interval}::interval
        AND (r.user_id IS NULL OR r.user_id IN (SELECT id FROM real_users))
        AND (r.user_id IS NOT NULL OR r.guest_id IS NOT NULL)`,
    sql``,
  );
}

/** A window over play timestamps: the last N days, or explicit Tbilisi dates (inclusive). */
export type PlayRange = { days: number } | { from: string; to: string };

function inRange(column: string, range: PlayRange) {
  return 'days' in range
    ? sql`${sql(column)} > now() - make_interval(days => ${range.days})`
    : sql`${sql(column)} >= (${range.from}::date::timestamp AT TIME ZONE ${TZ})
          AND ${sql(column)} < ((${range.to}::date + 1)::timestamp AT TIME ZONE ${TZ})`;
}

function dualRunGameUnions(range: PlayRange) {
  return DUAL_IDENTITY_RUN_TABLES.reduce(
    (acc, table) => sql`${acc}
      UNION ALL
      SELECT r.created_at, 'daily' FROM ${sql(table)} r
      WHERE ${inRange('r.created_at', range)}
        AND (r.user_id IS NULL OR r.user_id IN (SELECT id FROM real_users))
        AND (r.user_id IS NOT NULL OR r.guest_id IS NOT NULL)`,
    sql``,
  );
}

/**
 * Every game played in the range, one row per game with its mode bucket. A
 * match counts once however many humans sat in it.
 */
function gamesInRange(range: PlayRange) {
  return sql`
    WITH real_users AS (
      SELECT id FROM users
      WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted AND NOT is_guest
    )
    SELECT m.started_at AS at,
      CASE
        WHEN m.game_variant = 'football_grid' THEN 'grid'
        WHEN m.game_variant = 'friendly_party_quiz' THEN 'party_quiz'
        WHEN m.mode = 'auction' THEN 'auction'
        WHEN m.mode = 'ranked' THEN 'ranked'
        ELSE 'friendly'
      END AS mode
    FROM matches m
    WHERE m.is_dev = false AND ${inRange('m.started_at', range)}
      AND EXISTS (SELECT 1 FROM match_players mp JOIN real_users ru ON ru.id = mp.user_id
                  WHERE mp.match_id = m.id)
    UNION ALL
    SELECT dc.completed_at, 'daily' FROM daily_challenge_completions dc
    JOIN real_users ru ON ru.id = dc.user_id
    WHERE ${inRange('dc.completed_at', range)}
    UNION ALL
    SELECT gdc.created_at, 'daily' FROM guest_daily_completions gdc
    WHERE ${inRange('gdc.created_at', range)}
    UNION ALL
    SELECT r.created_at, 'squad_spin' FROM squad_spin_rounds r
    JOIN real_users ru ON ru.id = r.user_id WHERE ${inRange('r.created_at', range)}
    UNION ALL
    SELECT r.created_at, 'trivia_mines' FROM trivia_mines_rounds r
    JOIN real_users ru ON ru.id = r.user_id WHERE ${inRange('r.created_at', range)}
    UNION ALL
    SELECT r.created_at, 'free_kicks' FROM free_kicks_rounds r
    JOIN real_users ru ON ru.id = r.user_id WHERE ${inRange('r.created_at', range)}
    UNION ALL
    SELECT r.created_at, 'road_to_goal' FROM road_to_goal_rounds r
    JOIN real_users ru ON ru.id = r.user_id WHERE ${inRange('r.created_at', range)}
    UNION ALL
    SELECT s.created_at, 'guess_the_goal' FROM guess_the_goal_sessions s
    WHERE ${inRange('s.created_at', range)}
      AND (s.user_id IS NULL OR s.user_id IN (SELECT id FROM real_users))
    UNION ALL
    -- Weekend League: wl_answers holds one row per participant per question, so
    -- count each game once — a game is (tournament_id, game_index), timed by its
    -- first answer in range — and skip test tournaments.
    SELECT wg.at, 'weekend_league' FROM (
      SELECT min(a.created_at) AS at
      FROM wl_answers a
      JOIN real_users ru ON ru.id = a.user_id
      JOIN wl_tournaments wt ON wt.id = a.tournament_id AND NOT wt.is_test
      WHERE ${inRange('a.created_at', range)}
      GROUP BY a.tournament_id, a.game_index
    ) wg
    UNION ALL
    -- Duels (Buscaminas / Pistas head-to-head): once per started duel with a real human.
    SELECT dm.started_at, 'duel' FROM duel_matches dm
    WHERE ${inRange('dm.started_at', range)}
      AND EXISTS (SELECT 1 FROM duel_participants dp JOIN real_users ru ON ru.id = dp.user_id
                  WHERE dp.match_id = dm.id)
    ${dualRunGameUnions(range)}
  `;
}

/**
 * One identity per real person we can see: registered users pass the real-user
 * filter (no AI, seed, deleted or guest rows); anonymous play counts per guest
 * journey. The union covers every mode that records play with a timestamp.
 * Matches count when at least one real human sat in them (bot opponents are
 * not identities), and dev matches never count.
 */
const PLAY_IDENTITIES = (interval: string) => sql`
  WITH real_users AS (
    SELECT id FROM users
    WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted AND NOT is_guest
  )
  SELECT 'u:' || mp.user_id AS ident, m.started_at AS at
  FROM match_players mp
  JOIN matches m ON m.id = mp.match_id AND m.is_dev = false
  JOIN real_users ru ON ru.id = mp.user_id
  WHERE m.started_at > now() - ${interval}::interval
  UNION ALL
  SELECT 'u:' || dc.user_id, dc.completed_at
  FROM daily_challenge_completions dc
  JOIN real_users ru ON ru.id = dc.user_id
  WHERE dc.completed_at > now() - ${interval}::interval
  UNION ALL
  SELECT 'g:' || gdc.guest_id, gdc.created_at
  FROM guest_daily_completions gdc
  WHERE gdc.created_at > now() - ${interval}::interval
  UNION ALL
  SELECT 'u:' || r.user_id, r.created_at FROM squad_spin_rounds r
  JOIN real_users ru ON ru.id = r.user_id WHERE r.created_at > now() - ${interval}::interval
  UNION ALL
  SELECT 'u:' || r.user_id, r.created_at FROM trivia_mines_rounds r
  JOIN real_users ru ON ru.id = r.user_id WHERE r.created_at > now() - ${interval}::interval
  UNION ALL
  SELECT 'u:' || r.user_id, r.created_at FROM free_kicks_rounds r
  JOIN real_users ru ON ru.id = r.user_id WHERE r.created_at > now() - ${interval}::interval
  UNION ALL
  SELECT 'u:' || r.user_id, r.created_at FROM road_to_goal_rounds r
  JOIN real_users ru ON ru.id = r.user_id WHERE r.created_at > now() - ${interval}::interval
  UNION ALL
  SELECT coalesce('u:' || s.user_id::text, 'g:' || s.guest_id::text), s.created_at
  FROM guess_the_goal_sessions s
  WHERE s.created_at > now() - ${interval}::interval
    AND (s.user_id IS NULL OR s.user_id IN (SELECT id FROM real_users))
    AND (s.user_id IS NOT NULL OR s.guest_id IS NOT NULL)
  UNION ALL
  SELECT 'u:' || a.user_id, a.created_at
  FROM wl_answers a JOIN real_users ru ON ru.id = a.user_id
  JOIN wl_tournaments wt ON wt.id = a.tournament_id AND NOT wt.is_test
  WHERE a.created_at > now() - ${interval}::interval
  UNION ALL
  SELECT 'u:' || dp.user_id, dm.started_at
  FROM duel_matches dm
  JOIN duel_participants dp ON dp.match_id = dm.id
  JOIN real_users ru ON ru.id = dp.user_id
  WHERE dm.started_at > now() - ${interval}::interval
  ${dualRunIdentityUnions(interval)}
`;

export const adminStatsRepo = {
  /** Registered + played-guest totals with 30d conversion, same definitions as the PostHog tiles. */
  async totals(): Promise<AnalyticsTotalsRow> {
    const [row] = await sql<AnalyticsTotalsRow[]>`
      SELECT
        (SELECT count(*)::int FROM users
          WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted AND NOT is_guest) AS registered,
        (SELECT count(*)::int FROM guest_journeys
          WHERE first_play_at IS NOT NULL AND linked_user_id IS NULL) AS playing_guests,
        (SELECT count(*)::int FROM users
          WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted AND NOT is_guest)
        + (SELECT count(*)::int FROM guest_journeys
          WHERE first_play_at IS NOT NULL AND linked_user_id IS NULL) AS total_users,
        (SELECT count(*)::int FROM guest_journeys
          WHERE created_at > now() - interval '30 days' AND first_play_at IS NOT NULL) AS guests_played_30d,
        (SELECT count(*)::int FROM guest_journeys
          WHERE created_at > now() - interval '30 days' AND first_play_at IS NOT NULL
            AND linked_user_id IS NOT NULL) AS guests_converted_30d
    `;
    return row;
  },

  async actives(): Promise<ActivesRow> {
    const [row] = await sql<ActivesRow[]>`
      SELECT
        count(DISTINCT ident) FILTER (
          WHERE (at AT TIME ZONE ${TZ})::date = (now() AT TIME ZONE ${TZ})::date)::int AS dau,
        count(DISTINCT ident) FILTER (
          WHERE (at AT TIME ZONE ${TZ})::date > (now() AT TIME ZONE ${TZ})::date - 7)::int AS wau,
        count(DISTINCT ident)::int AS mau
      FROM (${PLAY_IDENTITIES('30 days')}) plays
    `;
    return row;
  },

  /** Distinct active identities per Tbilisi day, for the DAU trend chart. */
  async dauSeries(days: number): Promise<DayCountRow[]> {
    return sql<DayCountRow[]>`
      SELECT to_char((at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day,
             count(DISTINCT ident)::int AS count
      FROM (${PLAY_IDENTITIES(`${days} days`)}) plays
      GROUP BY 1 ORDER BY 1
    `;
  },

  async signupsPerDay(days: number): Promise<DayCountRow[]> {
    return sql<DayCountRow[]>`
      SELECT to_char((created_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, count(*)::int AS count
      FROM users
      WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted AND NOT is_guest
        AND created_at > now() - make_interval(days => ${days})
      GROUP BY 1 ORDER BY 1
    `;
  },

  /** Games played per Tbilisi day per mode. A match counts once however many humans sat in it. */
  async gamesPerDay(days: number): Promise<GamesPerDayRow[]> {
    return sql<GamesPerDayRow[]>`
      SELECT to_char((at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, mode, count(*)::int AS games
      FROM (${gamesInRange({ days })}) games GROUP BY 1, 2 ORDER BY 1, 2
    `;
  },

  /** Total games (same definition as gamesPerDay) between two Tbilisi dates, inclusive. */
  async gamesBetween(from: string, to: string): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (${gamesInRange({ from, to })}) games
    `;
    return row?.n ?? 0;
  },

  /** Registered + unconverted playing guests by country; converters count once as registered. */
  async countries(limit: number): Promise<CountryRow[]> {
    return sql<CountryRow[]>`
      WITH registered AS (
        SELECT coalesce(nullif(country, ''), 'unknown') AS country, count(*)::int AS n
        FROM users WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted AND NOT is_guest
        GROUP BY 1
      ), guests AS (
        SELECT coalesce(nullif(country, ''), 'unknown') AS country, count(*)::int AS n
        FROM guest_journeys WHERE first_play_at IS NOT NULL AND linked_user_id IS NULL
        GROUP BY 1
      )
      SELECT coalesce(r.country, g.country) AS country,
             coalesce(r.n, 0) AS registered, coalesce(g.n, 0) AS guests,
             coalesce(r.n, 0) + coalesce(g.n, 0) AS total
      FROM registered r FULL OUTER JOIN guests g USING (country)
      ORDER BY total DESC
      LIMIT ${limit}
    `;
  },
};

export interface PersonRow {
  id: string;
  kind: 'registered' | 'guest';
  nickname: string | null;
  email: string | null;
  country: string | null;
  created_at: string;
  coins: number | null;
  converted: boolean;
}

export interface ActivityRow {
  at: string;
  type: string;
  meta: Record<string, unknown>;
}

export const adminPersonsRepo = {
  async listRegistered(search: string | null, limit: number, offset: number): Promise<PersonRow[]> {
    return sql<PersonRow[]>`
      SELECT u.id::text AS id, 'registered' AS kind, u.nickname, u.email, u.country,
             u.created_at, u.coins, false AS converted
      FROM users u
      WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_deleted AND NOT u.is_guest
        AND (${search}::text IS NULL
          OR u.nickname ILIKE '%' || ${search} || '%'
          OR u.email ILIKE '%' || ${search} || '%'
          OR u.id::text = ${search})
      ORDER BY u.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  },

  async listGuests(search: string | null, limit: number, offset: number): Promise<PersonRow[]> {
    return sql<PersonRow[]>`
      SELECT g.guest_id::text AS id, 'guest' AS kind, NULL AS nickname, NULL AS email,
             coalesce(nullif(g.country, ''), NULL) AS country, g.created_at,
             NULL::int AS coins, (g.linked_user_id IS NOT NULL) AS converted
      FROM guest_journeys g
      WHERE g.first_play_at IS NOT NULL
        AND (${search}::text IS NULL OR g.guest_id::text = ${search})
      ORDER BY g.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  },

  /** A registered player's activity, newest first — the DB-truth "journey". */
  async registeredActivity(userId: string, limit: number): Promise<ActivityRow[]> {
    return sql<ActivityRow[]>`
      SELECT at, type, meta FROM (
        SELECT u.created_at AS at, 'account_created' AS type,
               jsonb_build_object('country', u.country) AS meta
        FROM users u WHERE u.id = ${userId}
        UNION ALL
        SELECT m.started_at, 'match', jsonb_build_object(
          'mode', m.mode, 'variant', m.game_variant,
          'placement', mp.placement, 'points', mp.total_points)
        FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = ${userId} AND m.is_dev = false
        UNION ALL
        SELECT dc.completed_at, 'daily_challenge', jsonb_build_object(
          'challenge', dc.challenge_type, 'score', dc.score, 'coins', dc.coins_awarded)
        FROM daily_challenge_completions dc WHERE dc.user_id = ${userId}
        UNION ALL
        SELECT r.created_at, 'squad_spin', jsonb_build_object(
          'stake', r.stake_coins, 'payout', r.payout_coins, 'status', r.status)
        FROM squad_spin_rounds r WHERE r.user_id = ${userId}
        UNION ALL
        SELECT r.created_at, 'trivia_mines', jsonb_build_object(
          'stake', r.stake_coins, 'payout', r.payout_coins, 'status', r.status)
        FROM trivia_mines_rounds r WHERE r.user_id = ${userId}
        UNION ALL
        SELECT r.created_at, 'free_kicks', jsonb_build_object(
          'stake', r.stake_coins, 'payout', r.payout_coins, 'status', r.status)
        FROM free_kicks_rounds r WHERE r.user_id = ${userId}
        UNION ALL
        SELECT r.created_at, 'road_to_goal', jsonb_build_object(
          'stake', r.stake_coins, 'payout', r.payout_coins, 'status', r.status)
        FROM road_to_goal_rounds r WHERE r.user_id = ${userId}
        UNION ALL
        SELECT s.created_at, 'guess_the_goal', jsonb_build_object(
          'points', s.points, 'correct', s.guess_correct)
        FROM guess_the_goal_sessions s WHERE s.user_id = ${userId}
        ${dailyRunTimeline('user_id', userId)}
        UNION ALL
        -- Weekend League: one entry per game played (non-test tournaments), at its first answer.
        SELECT min(a.created_at), 'weekend_league', jsonb_build_object(
          'tournament_id', a.tournament_id, 'game', a.game_index,
          'answers', count(*), 'correct', count(*) FILTER (WHERE a.correct), 'points', sum(a.points))
        FROM wl_answers a
        JOIN wl_tournaments wt ON wt.id = a.tournament_id AND NOT wt.is_test
        WHERE a.user_id = ${userId}
        GROUP BY a.tournament_id, a.game_index
        UNION ALL
        SELECT dm.started_at, 'duel', jsonb_build_object(
          'game', dm.game, 'outcome', dp.outcome, 'score', dp.score)
        FROM duel_participants dp JOIN duel_matches dm ON dm.id = dp.match_id
        WHERE dp.user_id = ${userId} AND dm.started_at IS NOT NULL
        UNION ALL
        SELECT l.created_at, 'coins', jsonb_build_object(
          'event', l.event_type, 'delta', l.coins_delta, 'reason', l.reason)
        FROM store_transaction_logs l WHERE l.user_id = ${userId} AND l.outcome = 'success'
      ) activity
      ORDER BY at DESC
      LIMIT ${limit}
    `;
  },

  /** A guest journey's activity from the guest-side tables. */
  async guestActivity(guestId: string, limit: number): Promise<ActivityRow[]> {
    return sql<ActivityRow[]>`
      SELECT at, type, meta FROM (
        SELECT g.created_at AS at, 'guest_journey_started' AS type,
               jsonb_build_object('country', g.country, 'first_mode', g.first_mode) AS meta
        FROM guest_journeys g WHERE g.guest_id = ${guestId}
        UNION ALL
        SELECT g.linked_at, 'converted_to_account',
               jsonb_build_object('link_type', g.link_type)
        FROM guest_journeys g WHERE g.guest_id = ${guestId} AND g.linked_at IS NOT NULL
        UNION ALL
        SELECT gdc.created_at, 'daily_challenge', jsonb_build_object(
          'challenge', gdc.challenge_type, 'score', gdc.best_score, 'attempts', gdc.attempts)
        FROM guest_daily_completions gdc WHERE gdc.guest_id = ${guestId}
        UNION ALL
        SELECT s.created_at, 'guess_the_goal', jsonb_build_object(
          'points', s.points, 'correct', s.guess_correct)
        FROM guess_the_goal_sessions s WHERE s.guest_id = ${guestId}
        ${dailyRunTimeline('guest_id', guestId)}
      ) activity
      ORDER BY at DESC
      LIMIT ${limit}
    `;
  },
};
