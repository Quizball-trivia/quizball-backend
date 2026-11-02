-- QuizBall HQ: analytics on a daily activity rollup.
--
-- Staging profiling (EXPLAIN ANALYZE): scanning raw play tables per request
-- is what made /analytics slow — free_kicks_rounds alone holds 1.44M rows in
-- the last 120 days, so a 16-week retention window read ~266k play rows (16 s)
-- and even a 30-day window took ~7 s (no created_at index; the planner walked
-- the whole (user_id, created_at) index from disk).
--
-- hq.activity_days keeps one row per identity per Tbilisi day — the same
-- identities admin-stats counts ('u:<user id>' for real registered users,
-- 'g:<guest id>' for anonymous play) — so analytics, retention and goal
-- progress read a few thousand rows instead of every play. It is backfilled
-- here once (≈10 s / 28k rows on staging) and kept current incrementally by
-- hq.ensure_activity_days(): finished days are computed once; today is
-- recomputed at most once a minute, under a try-lock (concurrent callers never
-- wait), using the created_at indexes added in the 2026110318001x-7x files.

CREATE TABLE hq.activity_days (
  day      date NOT NULL,
  ident    text NOT NULL,            -- 'u:<uuid>' | 'g:<uuid>'
  user_id  uuid,                     -- set for registered players
  PRIMARY KEY (day, ident)
);
CREATE INDEX hq_activity_days_user_idx ON hq.activity_days (user_id, day) WHERE user_id IS NOT NULL;

CREATE TABLE hq.activity_rollup_state (
  id                boolean PRIMARY KEY DEFAULT true CHECK (id),
  computed_from     date,          -- earliest day present in hq.activity_days
  complete_through  date,          -- days ≤ this were refreshed after they ended (final)
  refreshed_at      timestamptz
);
INSERT INTO hq.activity_rollup_state (id) VALUES (true);

-- Every play since p_from and before p_to, as identities. Mirrors
-- admin-stats PLAY_IDENTITIES: real registered users (no AI/seed/deleted/
-- guest-flag rows) and anonymous guests; dev matches never count; a match
-- counts for each real human seated in it. Tables missing in an environment
-- are skipped — add new play surfaces to the lists below.
CREATE FUNCTION hq.activity_source(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ident text, user_id uuid, at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  t text;
  rel regclass;
  has_col boolean;
  q text := $q$
    SELECT 'u:' || mp.user_id::text, mp.user_id, m.started_at
      FROM public.match_players mp
      JOIN public.matches m ON m.id = mp.match_id AND NOT m.is_dev
      JOIN real_users ru ON ru.id = mp.user_id
     WHERE m.started_at >= $1 AND m.started_at < $2$q$;
BEGIN
  IF to_regclass('public.daily_challenge_completions') IS NOT NULL THEN
    q := q || $q$
      UNION ALL SELECT 'u:' || d.user_id::text, d.user_id, d.completed_at
        FROM public.daily_challenge_completions d JOIN real_users ru ON ru.id = d.user_id
       WHERE d.completed_at >= $1 AND d.completed_at < $2$q$;
  END IF;
  IF to_regclass('public.guest_daily_completions') IS NOT NULL THEN
    q := q || $q$
      UNION ALL SELECT 'g:' || g.guest_id::text, NULL::uuid, g.created_at
        FROM public.guest_daily_completions g
       WHERE g.created_at >= $1 AND g.created_at < $2 AND g.guest_id IS NOT NULL$q$;
  END IF;
  -- registered-only rounds: (user_id, created_at)
  FOREACH t IN ARRAY ARRAY['squad_spin_rounds', 'trivia_mines_rounds', 'free_kicks_rounds', 'road_to_goal_rounds', 'wl_answers'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      q := q || format($f$
        UNION ALL SELECT 'u:' || r.user_id::text, r.user_id, r.created_at
          FROM public.%I r JOIN real_users ru ON ru.id = r.user_id
         WHERE r.created_at >= $1 AND r.created_at < $2$f$, t);
    END IF;
  END LOOP;
  -- user-or-guest surfaces: (user_id, guest_id, created_at)
  FOREACH t IN ARRAY ARRAY['guess_the_goal_sessions', 'ultimo_runs', 'name_chain_runs', 'buscaminas_runs', 'minuto_runs',
                           'pistas_runs', 'conexiones_runs', 'dato_falso_runs', 'codenames_runs', 'tenable_runs',
                           'football_race_runs', 'darts501_runs', 'grid_daily_runs', 'shared_player_runs'] LOOP
    rel := to_regclass('public.' || t);
    IF rel IS NOT NULL THEN
      SELECT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel AND a.attname = 'guest_id' AND NOT a.attisdropped)
        INTO has_col;
      q := q || format($f$
        UNION ALL SELECT COALESCE('u:' || r.user_id::text, %s), r.user_id, r.created_at
          FROM public.%I r
         WHERE r.created_at >= $1 AND r.created_at < $2
           AND (r.user_id IS NULL OR r.user_id IN (SELECT id FROM real_users))
           AND (r.user_id IS NOT NULL OR %s)$f$,
        CASE WHEN has_col THEN $c$'g:' || r.guest_id::text$c$ ELSE 'NULL' END, t,
        CASE WHEN has_col THEN 'r.guest_id IS NOT NULL' ELSE 'false' END);
    END IF;
  END LOOP;

  RETURN QUERY EXECUTE
    'WITH real_users AS (
       SELECT id FROM public.users WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted AND NOT is_guest
     ) ' || q
    USING p_from, p_to;
END;
$$;

-- Recomputes the rollup for Tbilisi days [p_from, p_to]. Returns rows written.
CREATE FUNCTION hq.refresh_activity_days(p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_to < p_from THEN
    RETURN 0;
  END IF;
  DELETE FROM hq.activity_days WHERE day BETWEEN p_from AND p_to;
  INSERT INTO hq.activity_days (day, ident, user_id)
  SELECT (s.at AT TIME ZONE 'Asia/Tbilisi')::date, s.ident, (array_agg(s.user_id))[1]
    FROM hq.activity_source(p_from::timestamp AT TIME ZONE 'Asia/Tbilisi',
                            (p_to + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi') s
   GROUP BY 1, 2;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Makes sure the rollup covers p_from → today and is at most ~1 minute old.
-- Never blocks: if another session is refreshing, it returns and the caller
-- reads the (seconds-old) rollup. No-op inside read-only transactions.
CREATE FUNCTION hq.ensure_activity_days(p_from date)
RETURNS void
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  st hq.activity_rollup_state;
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  v_from date := GREATEST(p_from, v_today - 400);   -- never backfill more than ~13 months on demand
BEGIN
  IF current_setting('transaction_read_only') = 'on' THEN
    RETURN;
  END IF;
  SELECT * INTO st FROM hq.activity_rollup_state WHERE id;
  IF st.computed_from IS NOT NULL AND v_from >= st.computed_from
     AND st.complete_through >= v_today - 1 AND st.refreshed_at > now() - interval '60 seconds' THEN
    RETURN;   -- fresh enough: the common path takes no lock and writes nothing
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('hq.activity_days')) THEN
    RETURN;
  END IF;
  SELECT * INTO st FROM hq.activity_rollup_state WHERE id FOR UPDATE;

  IF st.computed_from IS NULL THEN
    PERFORM hq.refresh_activity_days(v_from, v_today);
    st.computed_from := v_from;
  ELSE
    IF v_from < st.computed_from THEN
      PERFORM hq.refresh_activity_days(v_from, st.computed_from - 1);
      st.computed_from := v_from;
    END IF;
    PERFORM hq.refresh_activity_days(LEAST(COALESCE(st.complete_through + 1, v_today), v_today), v_today);
  END IF;

  UPDATE hq.activity_rollup_state
     SET computed_from = st.computed_from, complete_through = v_today - 1, refreshed_at = now()
   WHERE id;
END;
$$;

-- ── readers on the rollup (same outputs as before) ───────────────────────

-- Distinct identities (registered + guest) active on Tbilisi days [p_from, p_to].
CREATE FUNCTION hq.active_identities_between(p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
BEGIN
  PERFORM hq.ensure_activity_days(p_from);
  RETURN (SELECT count(DISTINCT ident) FROM hq.activity_days WHERE day BETWEEN p_from AND p_to);
END;
$$;

-- Output as in 20261103090000 plus, for the backend's Analytics page:
--   actives_all  {dau, wau, mau} counting guests too (admin-stats definition)
--   series[].active_all  daily active identities incl. guests
CREATE OR REPLACE FUNCTION hq.analytics_snapshot(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  v_days integer := LEAST(GREATEST(p_days, 1), 90);
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  v_first date := v_today - (LEAST(GREATEST(p_days, 1), 90) - 1);
BEGIN
  PERFORM hq.ensure_activity_days(LEAST(v_first, v_today - 29));
  RETURN (
    WITH real_users AS (
      SELECT u.id, u.country, u.created_at
        FROM public.users u
       WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
    ),
    activity AS (
      SELECT ad.day, ad.ident, ad.user_id FROM hq.activity_days ad WHERE ad.day >= LEAST(v_first, v_today - 29)
    ),
    human_matches AS (
      SELECT (m.started_at AT TIME ZONE 'Asia/Tbilisi')::date AS day,
             CASE
               WHEN m.game_variant = 'football_grid' THEN 'grid'
               WHEN m.game_variant = 'friendly_party_quiz' THEN 'party_quiz'
               WHEN m.mode = 'auction' THEN 'auction'
               WHEN m.mode = 'ranked' THEN 'ranked'
               ELSE 'friendly'
             END AS mode
        FROM public.matches m
       WHERE NOT m.is_dev
         AND m.started_at >= (v_first::timestamp AT TIME ZONE 'Asia/Tbilisi')
         AND EXISTS (SELECT 1 FROM public.match_players mp JOIN real_users ru ON ru.id = mp.user_id
                      WHERE mp.match_id = m.id)
    ),
    days AS (SELECT generate_series(v_first, v_today, interval '1 day')::date AS day),
    new_by_day AS (
      SELECT (ru.created_at AT TIME ZONE 'Asia/Tbilisi')::date AS day, count(*) AS n
        FROM real_users ru
       WHERE ru.created_at >= (v_first::timestamp AT TIME ZONE 'Asia/Tbilisi')
       GROUP BY 1
    ),
    active_by_day AS (
      SELECT day, count(*) FILTER (WHERE user_id IS NOT NULL) AS registered, count(*) AS all_idents
        FROM activity WHERE day >= v_first GROUP BY day
    ),
    matches_by_day AS (SELECT day, count(*) AS n FROM human_matches GROUP BY day)
    SELECT jsonb_build_object(
      'generated_at', now(),
      'timezone', 'Asia/Tbilisi',
      'days', v_days,
      'total_registered_users', (SELECT count(*) FROM real_users),
      'series', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'date', d.day::text,
                 'new_users', COALESCE(nu.n, 0),
                 'active_players', COALESCE(ap.registered, 0),
                 'active_all', COALESCE(ap.all_idents, 0),
                 'matches', COALESCE(mt.n, 0)
               ) ORDER BY d.day), '[]'::jsonb)
          FROM days d
          LEFT JOIN new_by_day nu ON nu.day = d.day
          LEFT JOIN active_by_day ap ON ap.day = d.day
          LEFT JOIN matches_by_day mt ON mt.day = d.day
      ),
      'actives', (
        SELECT jsonb_build_object(
          'dau', count(DISTINCT a.user_id) FILTER (WHERE a.day = v_today),
          'wau', count(DISTINCT a.user_id) FILTER (WHERE a.day > v_today - 7),
          'mau', count(DISTINCT a.user_id) FILTER (WHERE a.day > v_today - 30)
        ) FROM activity a WHERE a.user_id IS NOT NULL
      ),
      'actives_all', (
        SELECT jsonb_build_object(
          'dau', count(DISTINCT a.ident) FILTER (WHERE a.day = v_today),
          'wau', count(DISTINCT a.ident) FILTER (WHERE a.day > v_today - 7),
          'mau', count(DISTINCT a.ident) FILTER (WHERE a.day > v_today - 30)
        ) FROM activity a
      ),
      'modes', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('mode', mode, 'matches', n) ORDER BY n DESC, mode)
          FROM (SELECT mode, count(*) AS n FROM human_matches GROUP BY mode) s
      ), '[]'::jsonb),
      'modes_by_day', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('date', day::text, 'mode', mode, 'matches', n) ORDER BY day, mode)
          FROM (SELECT day, mode, count(*) AS n FROM human_matches GROUP BY day, mode) s
      ), '[]'::jsonb),
      'countries', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('country', country, 'players', players, 'registered', registered)
                         ORDER BY players DESC, registered DESC, country)
          FROM (
            SELECT COALESCE(NULLIF(ru.country, ''), 'unknown') AS country,
                   count(*) FILTER (WHERE ap.user_id IS NOT NULL) AS players,
                   count(*) AS registered
              FROM real_users ru
              LEFT JOIN (SELECT DISTINCT a.user_id FROM activity a WHERE a.day >= v_first AND a.user_id IS NOT NULL) ap
                ON ap.user_id = ru.id
             GROUP BY 1
          ) c
      ), '[]'::jsonb)
    )
  );
END;
$$;

-- Same output and definitions as before (cohorts of real registered users;
-- d1 = day S+1, d7 = S+7…S+13, d30 = S+30…S+59; NULL until elapsed), now
-- reading per-user active days from the rollup.
CREATE OR REPLACE FUNCTION hq.retention_cohorts(p_weeks integer DEFAULT 8)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  v_first_week date := date_trunc('week', (now() AT TIME ZONE 'Asia/Tbilisi'))::date
                       - (LEAST(GREATEST(p_weeks, 1), 26) - 1) * 7;
BEGIN
  PERFORM hq.ensure_activity_days(v_first_week);
  RETURN (
    WITH cohort_users AS MATERIALIZED (
      SELECT u.id,
             (u.created_at AT TIME ZONE 'Asia/Tbilisi')::date AS signup_day,
             date_trunc('week', (u.created_at AT TIME ZONE 'Asia/Tbilisi'))::date AS cohort_start
        FROM public.users u
       WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
         AND u.created_at >= (v_first_week::timestamp AT TIME ZONE 'Asia/Tbilisi')
    ),
    per_user AS (
      SELECT cu.cohort_start,
             COALESCE(bool_or(ad.day = cu.signup_day + 1), false) AS r1,
             COALESCE(bool_or(ad.day BETWEEN cu.signup_day + 7 AND cu.signup_day + 13), false) AS r7,
             COALESCE(bool_or(ad.day BETWEEN cu.signup_day + 30 AND cu.signup_day + 59), false) AS r30
        FROM cohort_users cu
        LEFT JOIN hq.activity_days ad
          ON ad.user_id = cu.id AND ad.day BETWEEN cu.signup_day + 1 AND cu.signup_day + 59
       GROUP BY cu.id, cu.cohort_start
    ),
    cohorts AS (
      SELECT cohort_start, count(*) AS size,
             count(*) FILTER (WHERE r1) AS r1, count(*) FILTER (WHERE r7) AS r7, count(*) FILTER (WHERE r30) AS r30
        FROM per_user GROUP BY cohort_start
    ),
    weeks AS (
      SELECT generate_series(v_first_week, date_trunc('week', v_today::timestamp)::date, interval '7 days')::date AS cohort_start
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'cohort_start', w.cohort_start::text,
             'size', COALESCE(c.size, 0),
             'd1',  CASE WHEN v_today > w.cohort_start + 6 + 1  AND c.size > 0 THEN round(c.r1::numeric / c.size, 3) END,
             'd7',  CASE WHEN v_today > w.cohort_start + 6 + 13 AND c.size > 0 THEN round(c.r7::numeric / c.size, 3) END,
             'd30', CASE WHEN v_today > w.cohort_start + 6 + 59 AND c.size > 0 THEN round(c.r30::numeric / c.size, 3) END
           ) ORDER BY w.cohort_start), '[]'::jsonb)
      FROM weeks w
      LEFT JOIN cohorts c ON c.cohort_start = w.cohort_start
  );
END;
$$;

-- ── access ─────────────────────────────────────────────────────────────────
ALTER TABLE hq.activity_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE hq.activity_rollup_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION hq.activity_source(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.refresh_activity_days(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.ensure_activity_days(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.active_identities_between(date, date) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON hq.activity_days, hq.activity_rollup_state TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.activity_source(timestamptz, timestamptz) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.refresh_activity_days(date, date) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.ensure_activity_days(date) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.active_identities_between(date, date) TO service_role';
  END IF;
END $$;

-- ── one-time backfill: 26 weeks of retention + their D30 windows ─────────
-- (≈10 s / 28k rows on staging; reads only, inside this transaction.)
DO $$
BEGIN
  PERFORM hq.ensure_activity_days((now() AT TIME ZONE 'Asia/Tbilisi')::date - 185);
END $$;
