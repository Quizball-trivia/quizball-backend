-- QuizBall HQ v3 fixes, round 4 (everything through 20261103210000 is applied).
--
-- The activity rollup must never present days it hasn't computed as zero.
-- "Covered from D" means: the rollup starts on or before D AND every finished
-- day has been finalised (complete_through ≥ yesterday). ensure_activity_days
-- only skips without waiting when the request is already covered (then the
-- only thing at stake is today's ≤1-minute freshness); otherwise it WAITS for
-- the refresh lock (bounded by statement_timeout) and computes. Readers
-- re-check coverage afterwards: goal windows return NULL (unknown), analytics
-- raise instead of showing zeros (only possible in a read-only transaction).

CREATE FUNCTION hq.activity_covered(p_from date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = hq, pg_temp
AS $$
  SELECT COALESCE(st.computed_from <= p_from
                  AND st.complete_through >= (now() AT TIME ZONE 'Asia/Tbilisi')::date - 1, false)
    FROM hq.activity_rollup_state st WHERE st.id;
$$;

CREATE FUNCTION hq.assert_activity_covered(p_from date)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = hq, pg_temp
AS $$
BEGIN
  IF NOT hq.activity_covered(p_from) THEN
    RAISE EXCEPTION 'hq.activity_days does not cover % yet (call from a read-write transaction so it can refresh)', p_from
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hq.ensure_activity_days(p_from date)
RETURNS void
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  st hq.activity_rollup_state;
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  v_from date := GREATEST(p_from, v_today - 400);   -- never backfill more than ~13 months on demand
  v_covered boolean;
BEGIN
  SELECT * INTO st FROM hq.activity_rollup_state WHERE id;
  v_covered := st.computed_from IS NOT NULL AND v_from >= st.computed_from AND st.complete_through >= v_today - 1;
  IF v_covered AND st.refreshed_at > now() - interval '60 seconds' THEN
    RETURN;   -- covered and fresh: the common path takes no lock and writes nothing
  END IF;
  IF current_setting('transaction_read_only') = 'on' THEN
    RETURN;   -- can't refresh; readers check coverage themselves
  END IF;

  IF v_covered THEN
    -- Only today's freshness is at stake: never wait for a concurrent refresh.
    IF NOT pg_try_advisory_xact_lock(hashtext('hq.activity_days')) THEN
      RETURN;
    END IF;
  ELSE
    -- Missing days: wait for whoever is refreshing, then re-check.
    PERFORM pg_advisory_xact_lock(hashtext('hq.activity_days'));
  END IF;

  SELECT * INTO st FROM hq.activity_rollup_state WHERE id FOR UPDATE;
  IF st.computed_from IS NOT NULL AND v_from >= st.computed_from AND st.complete_through >= v_today - 1
     AND st.refreshed_at > now() - interval '60 seconds' THEN
    RETURN;   -- someone else just did it
  END IF;

  IF st.computed_from IS NULL THEN
    PERFORM hq.refresh_activity_days(v_from, v_today);
    st.computed_from := v_from;
  ELSE
    IF v_from < st.computed_from THEN
      PERFORM hq.refresh_activity_days(v_from, st.computed_from - 1);
      st.computed_from := v_from;
    END IF;
    -- Reconciliation overlap: yesterday is always recomputed with today.
    PERFORM hq.refresh_activity_days(
      GREATEST(LEAST(COALESCE(st.complete_through + 1, v_today - 1), v_today - 1), st.computed_from),
      v_today);
  END IF;

  UPDATE hq.activity_rollup_state
     SET computed_from = st.computed_from, complete_through = v_today - 1, refreshed_at = now()
   WHERE id;
END;
$$;

-- NULL (unknown) unless every day of the window is covered: the rollup starts
-- by p_from and all finished days up to the window's end are finalised.
CREATE OR REPLACE FUNCTION hq.active_identities_between(p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  st hq.activity_rollup_state;
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
BEGIN
  PERFORM hq.ensure_activity_days(p_from);
  SELECT * INTO st FROM hq.activity_rollup_state WHERE id;
  IF st.computed_from IS NULL OR p_from < st.computed_from
     OR st.complete_through IS NULL OR st.complete_through < LEAST(p_to, v_today - 1) THEN
    RETURN NULL;
  END IF;
  RETURN (
    SELECT count(DISTINCT ad.ident)
      FROM hq.activity_days ad
      LEFT JOIN public.users u
        ON u.id = ad.user_id AND NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
     WHERE ad.day BETWEEN p_from AND p_to
       AND (ad.user_id IS NULL OR u.id IS NOT NULL)
  );
END;
$$;

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
  PERFORM hq.assert_activity_covered(LEAST(v_first, v_today - 29));
  RETURN (
    WITH real_users AS (
      SELECT u.id, u.country, u.created_at
        FROM public.users u
       WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
    ),
    -- Re-apply today's eligibility to registered identities (an account
    -- deleted or flagged since the day was rolled up stops counting); guests
    -- ('g:' rows, user_id NULL) are unaffected.
    activity AS (
      SELECT ad.day, ad.ident, ad.user_id
        FROM hq.activity_days ad
        LEFT JOIN real_users ru ON ru.id = ad.user_id
       WHERE ad.day >= LEAST(v_first, v_today - 29)
         AND (ad.user_id IS NULL OR ru.id IS NOT NULL)
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
  PERFORM hq.assert_activity_covered(v_first_week);
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

REVOKE ALL ON FUNCTION hq.activity_covered(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.assert_activity_covered(date) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.activity_covered(date) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.assert_activity_covered(date) TO service_role';
  END IF;
END $$;
