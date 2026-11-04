-- Audience: who played, per Georgia day and game mode, from the tables every game already writes.
-- One person = one ident: registered users are u:<user id>; guests are g:<guest id>, where a guest account
-- (users.is_guest) resolves to its guest id, and a guest who later signed up or logged in resolves to the member
-- (guest_journeys.linked_user_id, also re-applied when reading). kind is the access at play time.
-- Excludes AI, seeds, deleted users, admins, partner players and partner staff, dev matches and test tournaments.
-- Tic Tac Toe is a matches row (game_variant football_grid); football_grid_participants is the same roster.
-- Known limits: a run is dated by the day it was created, so a game resumed on a later day only counts once;
-- guest daily completions are one row however many attempts; warmup and campaign quiz answers record no play.

CREATE SCHEMA IF NOT EXISTS audience;
REVOKE ALL ON SCHEMA audience FROM PUBLIC, anon, authenticated;

CREATE TABLE audience.player_days (
  day             date NOT NULL,
  ident           text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('registered', 'guest')),
  mode            text NOT NULL,
  plays           integer NOT NULL,
  user_id         uuid,
  guest_id        text,
  PRIMARY KEY (day, ident, kind, mode)
);
CREATE INDEX player_days_ident_day_idx ON audience.player_days (ident, day);

-- complete = refreshed at least an hour after the day ended (late commits included), so it will not change.
CREATE TABLE audience.refresh_state (
  day           date PRIMARY KEY,
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  complete      boolean NOT NULL DEFAULT false,
  rows          integer NOT NULL
);

-- First day each ident ever played (min over refreshed days).
CREATE TABLE audience.ident_first_day (
  ident      text PRIMARY KEY,
  first_day  date NOT NULL
);

-- Guest account -> browser guest id, kept here because guest cleanup deletes the guest identity after 45 idle days.
CREATE TABLE audience.guest_accounts (
  user_id   uuid PRIMARY KEY,
  guest_id  text NOT NULL
);
INSERT INTO audience.guest_accounts (user_id, guest_id)
SELECT DISTINCT ON (ui.user_id) ui.user_id, ui.subject
  FROM public.user_identities ui JOIN public.users u ON u.id = ui.user_id AND u.is_guest
 WHERE ui.provider = 'guest'
 ORDER BY ui.user_id, ui.subject
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION audience.eligible_user(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM users u
     WHERE u.id = p_user_id AND NOT u.is_ai AND NOT u.is_seed AND NOT u.is_deleted AND u.deleted_at IS NULL
       AND u.partner_slug IS NULL AND coalesce(u.role, 'user') NOT IN ('admin', 'partner_staff'))
$fn$;

CREATE OR REPLACE FUNCTION audience.activity(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ident text, kind text, user_id uuid, guest_id text, mode text, at timestamptz)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH eligible AS (
    SELECT u.id, u.is_guest FROM users u
    WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_deleted AND u.deleted_at IS NULL
      AND u.partner_slug IS NULL AND coalesce(u.role, 'user') NOT IN ('admin', 'partner_staff')
  ),
  guest_acct AS (
    SELECT DISTINCT ON (g.guest_user_id) g.guest_user_id, g.guest_id::text AS guest_id
    FROM guest_journeys g WHERE g.guest_user_id IS NOT NULL ORDER BY g.guest_user_id, g.created_at
  ),
  account_guest AS (  -- guest account -> its browser guest id (one row per account)
    SELECT e.id AS user_id, coalesce(sa.guest_id, ui.subject, ga.guest_id) AS guest_id
    FROM eligible e
    LEFT JOIN LATERAL (
      SELECT i.subject FROM user_identities i WHERE i.user_id = e.id AND i.provider = 'guest' ORDER BY i.subject LIMIT 1
    ) ui ON true
    LEFT JOIN audience.guest_accounts sa ON sa.user_id = e.id
    LEFT JOIN guest_acct ga ON ga.guest_user_id = e.id
    WHERE e.is_guest
  ),
  guest_member AS (  -- browser guest -> the member it became
    SELECT g.guest_id::text AS guest_id, g.linked_user_id
    FROM guest_journeys g JOIN eligible m ON m.id = g.linked_user_id AND NOT m.is_guest
  ),
  acct AS (  -- plays recorded against a users row
    SELECT mp.user_id, CASE m.game_variant::text
             WHEN 'football_grid' THEN 'tic_tac_toe' WHEN 'ranked_sim' THEN 'ranked'
             WHEN 'friendly_party_quiz' THEN 'party_quiz' WHEN 'friendly_possession' THEN 'friendly'
             WHEN 'auction' THEN 'auction' ELSE coalesce(m.mode::text, 'match') END AS mode, m.started_at AS at
      FROM match_players mp JOIN matches m ON m.id = mp.match_id AND NOT m.is_dev
     WHERE m.started_at >= p_from AND m.started_at < p_to
    UNION ALL SELECT d.user_id, 'daily:' || d.challenge_type::text, d.completed_at FROM daily_challenge_completions d
     WHERE d.completed_at >= p_from AND d.completed_at < p_to
    UNION ALL SELECT g.user_id, 'weekend_league', g.first_at  -- one per game, on the day of its first answer
      FROM (SELECT a.user_id, min(a.created_at) AS first_at
              FROM wl_answers a JOIN wl_tournaments wt ON wt.id = a.tournament_id AND NOT wt.is_test
             WHERE a.created_at >= p_from - interval '1 day' AND a.created_at < p_to
             GROUP BY a.user_id, a.tournament_id, a.game_index) g
     WHERE g.first_at >= p_from AND g.first_at < p_to
    UNION ALL SELECT dp.user_id, 'duel:' || dm.game::text, dm.started_at
      FROM duel_matches dm JOIN duel_participants dp ON dp.match_id = dm.id
     WHERE dm.started_at >= p_from AND dm.started_at < p_to
    UNION ALL SELECT rs.user_id, 'room:' || rm.game::text, rm.started_at
      FROM room_matches rm JOIN room_seats rs ON rs.match_id = rm.id AND rs.admitted
     WHERE rm.started_at >= p_from AND rm.started_at < p_to
    UNION ALL SELECT r.user_id, 'squad_spin', r.created_at FROM squad_spin_rounds r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, 'trivia_mines', r.created_at FROM trivia_mines_rounds r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, 'free_kicks', r.created_at FROM free_kicks_rounds r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, 'road_to_goal', r.created_at FROM road_to_goal_rounds r WHERE r.created_at >= p_from AND r.created_at < p_to
  ),
  runs AS (  -- user-or-guest tables
    SELECT r.user_id, r.guest_id::text AS guest_id, 'buscaminas' AS mode, r.created_at AS at FROM buscaminas_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'minuto', r.created_at FROM minuto_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'guess_the_goal', r.created_at FROM guess_the_goal_sessions r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'tenable', r.created_at FROM tenable_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'shared_player', r.created_at FROM shared_player_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'ultimo', r.created_at FROM ultimo_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'pistas', r.created_at FROM pistas_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'name_chain', r.created_at FROM name_chain_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'football_race', r.created_at FROM football_race_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'codenames', r.created_at FROM codenames_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'dato_falso', r.created_at FROM dato_falso_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'conexiones', r.created_at FROM conexiones_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'darts501', r.created_at FROM darts501_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT r.user_id, r.guest_id::text, 'grid_daily', r.created_at FROM grid_daily_runs r WHERE r.created_at >= p_from AND r.created_at < p_to
    UNION ALL SELECT NULL::uuid, g.guest_id::text, 'daily:' || g.challenge_type::text, g.created_at FROM guest_daily_completions g
     WHERE g.created_at >= p_from AND g.created_at < p_to
  ),
  resolved AS (
    SELECT a.user_id, e.is_guest, CASE WHEN e.is_guest THEN ag.guest_id END AS guest_id, a.mode, a.at
      FROM acct a JOIN eligible e ON e.id = a.user_id LEFT JOIN account_guest ag ON ag.user_id = a.user_id
    UNION ALL
    SELECT r.user_id, coalesce(e.is_guest, true), CASE WHEN e.is_guest IS DISTINCT FROM false THEN coalesce(r.guest_id, ag.guest_id) END, r.mode, r.at
      FROM runs r LEFT JOIN eligible e ON e.id = r.user_id LEFT JOIN account_guest ag ON ag.user_id = r.user_id
     WHERE (r.user_id IS NULL AND r.guest_id IS NOT NULL) OR e.id IS NOT NULL
  )
  SELECT CASE WHEN NOT x.is_guest THEN 'u:' || x.user_id::text
              ELSE coalesce('u:' || gm.linked_user_id::text, 'g:' || coalesce(x.guest_id, 'acct:' || x.user_id::text)) END AS ident,
         CASE WHEN x.is_guest THEN 'guest' ELSE 'registered' END AS kind,
         CASE WHEN NOT x.is_guest THEN x.user_id ELSE coalesce(gm.linked_user_id, x.user_id) END AS user_id,
         x.guest_id, x.mode, x.at
    FROM resolved x LEFT JOIN guest_member gm ON x.is_guest AND gm.guest_id = x.guest_id
$fn$;

-- Replaces the rows of [p_from, p_to] (Georgia days) atomically. Callers serialise on a transaction lock; with
-- p_wait = false a caller returns -1 when the lock is taken, or -2 when every day was refreshed in the last 5 minutes
-- (another replica just did it), instead of repeating the work.
CREATE OR REPLACE FUNCTION audience.refresh_days(p_from date, p_to date, p_wait boolean DEFAULT true)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  n integer;
BEGIN
  IF p_to < p_from OR p_to - p_from > 31 THEN
    RAISE EXCEPTION 'audience.refresh_days: bad range % .. %', p_from, p_to;
  END IF;
  IF p_wait THEN
    PERFORM pg_advisory_xact_lock(hashtext('audience.refresh_days'));
  ELSIF NOT pg_try_advisory_xact_lock(hashtext('audience.refresh_days')) THEN
    RETURN -1;
  ELSIF NOT EXISTS (
    SELECT 1 FROM generate_series(p_from, p_to, interval '1 day') d
     WHERE NOT EXISTS (SELECT 1 FROM audience.refresh_state s WHERE s.day = d::date AND s.refreshed_at > now() - interval '5 minutes')
  ) THEN
    RETURN -2;
  END IF;

  INSERT INTO audience.guest_accounts (user_id, guest_id)
  SELECT DISTINCT ON (ui.user_id) ui.user_id, ui.subject
    FROM user_identities ui JOIN users u ON u.id = ui.user_id AND u.is_guest
   WHERE ui.provider = 'guest'
   ORDER BY ui.user_id, ui.subject
  ON CONFLICT (user_id) DO NOTHING;

  DELETE FROM audience.player_days WHERE day BETWEEN p_from AND p_to;
  INSERT INTO audience.player_days (day, ident, kind, mode, plays, user_id, guest_id)
  SELECT (a.at AT TIME ZONE 'Asia/Tbilisi')::date, a.ident, a.kind, a.mode, count(*)::int, max(a.user_id::text)::uuid, max(a.guest_id)
    FROM audience.activity(p_from::timestamp AT TIME ZONE 'Asia/Tbilisi', (p_to + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi') a
   GROUP BY 1, 2, 3, 4;
  GET DIAGNOSTICS n = ROW_COUNT;

  -- Recompute first days for every ident seen in the range or whose first day was in it, so a correction that
  -- removes someone's earliest play moves their first day later (or drops it).
  WITH touched AS (
    SELECT DISTINCT p.ident FROM audience.player_days p WHERE p.day BETWEEN p_from AND p_to
    UNION SELECT f.ident FROM audience.ident_first_day f WHERE f.first_day BETWEEN p_from AND p_to
  ),
  recomputed AS (
    SELECT t.ident, (SELECT min(p.day) FROM audience.player_days p WHERE p.ident = t.ident) AS first_day FROM touched t
  ),
  dropped AS (
    DELETE FROM audience.ident_first_day f USING recomputed r WHERE f.ident = r.ident AND r.first_day IS NULL
  )
  INSERT INTO audience.ident_first_day (ident, first_day)
  SELECT r.ident, r.first_day FROM recomputed r WHERE r.first_day IS NOT NULL
  ON CONFLICT (ident) DO UPDATE SET first_day = EXCLUDED.first_day;

  INSERT INTO audience.refresh_state (day, refreshed_at, complete, rows)
  SELECT d::date, now(), now() >= ((d::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi') + interval '1 hour',
         coalesce((SELECT count(*) FROM audience.player_days p WHERE p.day = d::date), 0)
    FROM generate_series(p_from, p_to, interval '1 day') d
  ON CONFLICT (day) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at, complete = EXCLUDED.complete, rows = EXCLUDED.rows;
  RETURN n;
END;
$fn$;

REVOKE ALL ON ALL TABLES IN SCHEMA audience FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA audience FROM PUBLIC, anon, authenticated;
