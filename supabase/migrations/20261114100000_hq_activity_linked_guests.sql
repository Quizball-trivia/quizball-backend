-- HQ North Star: a guest who signed up or logged in counted as two players (their guest ident and their member ident)
-- whenever both played in the same 7 Tbilisi days. The link lives only in public.guest_journeys (guest_id = browser
-- guest session, guest_user_id = its guest account, linked_user_id = the member). Now:
--   1. hq.activity_source reports such guest play as 'u:<member>', with user_id still NULL: all-players counts merge the
--      person, registered-only figures (which read user_id) stay exactly as before.
--   2. hq.refresh_activity_days keeps the member's user_id when a day holds both their guest and member play, and
--      records each guest ident it merged into a member in hq.activity_day_merges.
--   3. hq.reconcile_linked_guest_days(p_max_days) re-rolls, newest first, the retained days (Tbilisi today-95 .. today)
--      whose rollup no longer matches the links: a guest ident that now resolves to a member, or a recorded merge that
--      no longer holds. The backend runs one batch in its own transaction every minute per replica (worker and HQ pulse
--      reads share the throttle), so days rolled up before a guest linked are corrected without a manual step and a
--      slow batch never fails a read. Nothing is refreshed here.
-- Rollback: restore hq.activity_source (20261111130000) and hq.refresh_activity_days (20261103180000), drop the new
-- functions, hq.activity_day_merges (and the backend worker/call), then re-run the same days through
-- hq.refresh_activity_days in batches, each under pg_advisory_xact_lock(hashtext('hq.activity_days')).

-- Guest idents (as hq.activity_source emits them) that resolve to exactly one real member: 'g:<guest id>' through
-- guest_journeys.guest_id, and a guest account's ident ('g:<its guest identity>' or 'a:<account id>', as in
-- activity_source's guest_accounts) through guest_journeys.guest_user_id. Both link types count, whenever the play
-- happened. An ident linked to two different members is left out (stays a guest).
CREATE FUNCTION hq.linked_guest_idents()
RETURNS TABLE (ident text, member_id uuid)
LANGUAGE plpgsql
STABLE
SET search_path = hq, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF to_regclass('public.guest_journeys') IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    WITH links AS (
      SELECT j.guest_id, j.guest_user_id, j.linked_user_id
        FROM public.guest_journeys j
        JOIN public.users m ON m.id = j.linked_user_id
       WHERE j.linked_user_id IS NOT NULL
         AND NOT m.is_ai AND NOT m.is_seed AND NOT m.is_deleted AND NOT m.is_guest
    ), keyed AS (
      SELECT 'g:' || l.guest_id::text AS ident, l.linked_user_id FROM links l
      UNION ALL
      SELECT COALESCE('g:' || (SELECT ui.subject FROM public.user_identities ui
                                WHERE ui.user_id = ga.id AND ui.provider = 'guest'
                                ORDER BY ui.created_at LIMIT 1),
                      'a:' || ga.id::text),
             l.linked_user_id
        FROM links l
        JOIN public.users ga ON ga.id = l.guest_user_id
       WHERE ga.is_guest AND NOT ga.is_ai AND NOT ga.is_seed AND NOT ga.is_deleted
    )
    SELECT k.ident, (array_agg(k.linked_user_id))[1]
      FROM keyed k
     GROUP BY k.ident
    HAVING count(DISTINCT k.linked_user_id) = 1;
END;
$$;

-- The guest idents a rolled-up day merged into a member ('u:<member>'), so a merge that stops holding (a later
-- conflicting link, the member deleted) is found again. Written only by hq.refresh_activity_days.
CREATE TABLE hq.activity_day_merges (
  day          date NOT NULL,
  guest_ident  text NOT NULL,
  ident        text NOT NULL,
  PRIMARY KEY (day, guest_ident)
);

-- hq.activity_source plus, on guest play resolved to a member, the guest ident it was (else NULL).
CREATE FUNCTION hq.activity_source_linked(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ident text, user_id uuid, at timestamptz, guest_ident text)
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
  -- Weekend League: one identity per participant, test tournaments excluded.
  IF to_regclass('public.wl_answers') IS NOT NULL AND to_regclass('public.wl_tournaments') IS NOT NULL THEN
    q := q || $q$
      UNION ALL SELECT 'u:' || a.user_id::text, a.user_id, a.created_at
        FROM public.wl_answers a
        JOIN real_users ru ON ru.id = a.user_id
        JOIN public.wl_tournaments wt ON wt.id = a.tournament_id AND NOT wt.is_test
       WHERE a.created_at >= $1 AND a.created_at < $2$q$;
  END IF;
  -- Duels (Buscaminas / Pistas head-to-head): each real registered seat, when
  -- the duel started. Guest seats are users.is_guest friend-room accounts,
  -- which no surface counts (matches exclude them too).
  IF to_regclass('public.duel_participants') IS NOT NULL AND to_regclass('public.duel_matches') IS NOT NULL THEN
    q := q || $q$
      UNION ALL SELECT 'u:' || dp.user_id::text, dp.user_id, dm.started_at
        FROM public.duel_matches dm
        JOIN public.duel_participants dp ON dp.match_id = dm.id
        JOIN real_users ru ON ru.id = dp.user_id
       WHERE dm.started_at >= $1 AND dm.started_at < $2$q$;
  END IF;
  -- Friend rooms (Aproximado, Codenames, Tenable, … via roomRepo.insertMatch):
  -- each admitted real registered seat, when the room match started. Guest
  -- seats are users.is_guest accounts, not counted (as for matches and duels).
  IF to_regclass('public.room_seats') IS NOT NULL AND to_regclass('public.room_matches') IS NOT NULL THEN
    q := q || $q$
      UNION ALL SELECT 'u:' || rs.user_id::text, rs.user_id, rm.started_at
        FROM public.room_matches rm
        JOIN public.room_seats rs ON rs.match_id = rm.id AND rs.admitted
        JOIN real_users ru ON ru.id = rs.user_id
       WHERE rm.started_at >= $1 AND rm.started_at < $2$q$;
  END IF;
  FOREACH t IN ARRAY ARRAY['squad_spin_rounds', 'trivia_mines_rounds', 'free_kicks_rounds', 'road_to_goal_rounds'] LOOP
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

  -- Guest accounts (users.is_guest: a guest playing ranked/Grid/auction, a duel or a friend room) count as guests.
  -- A guest account linked to its guest session (user_identities, provider 'guest') is the same person as that
  -- session's daily guest 'g:<session>'; an unlinked one counts as 'a:<user id>'.
  q := q || $q$
    UNION ALL SELECT ga.ident, NULL::uuid, m.started_at
      FROM public.match_players mp
      JOIN public.matches m ON m.id = mp.match_id AND NOT m.is_dev
      JOIN guest_accounts ga ON ga.id = mp.user_id
     WHERE m.started_at >= $1 AND m.started_at < $2$q$;
  IF to_regclass('public.duel_participants') IS NOT NULL AND to_regclass('public.duel_matches') IS NOT NULL THEN
    q := q || $q$
      UNION ALL SELECT ga.ident, NULL::uuid, dm.started_at
        FROM public.duel_matches dm
        JOIN public.duel_participants dp ON dp.match_id = dm.id
        JOIN guest_accounts ga ON ga.id = dp.user_id
       WHERE dm.started_at >= $1 AND dm.started_at < $2$q$;
  END IF;
  IF to_regclass('public.room_seats') IS NOT NULL AND to_regclass('public.room_matches') IS NOT NULL THEN
    q := q || $q$
      UNION ALL SELECT ga.ident, NULL::uuid, rm.started_at
        FROM public.room_matches rm
        JOIN public.room_seats rs ON rs.match_id = rm.id AND rs.admitted
        JOIN guest_accounts ga ON ga.id = rs.user_id
       WHERE rm.started_at >= $1 AND rm.started_at < $2$q$;
  END IF;

  -- A guest who signed up or logged in is the member they became: 'u:<member>', but user_id stays NULL (guest play).
  RETURN QUERY EXECUTE
    'WITH real_users AS (
       SELECT id FROM public.users WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted AND NOT is_guest
     ), guest_accounts AS (
       SELECT u.id,
              COALESCE(''g:'' || (SELECT ui.subject FROM public.user_identities ui
                                   WHERE ui.user_id = u.id AND ui.provider = ''guest''
                                   ORDER BY ui.created_at LIMIT 1),
                       ''a:'' || u.id::text) AS ident
         FROM public.users u WHERE u.is_guest AND NOT u.is_ai AND NOT u.is_seed AND NOT u.is_deleted
     ), linked AS (
       SELECT l.ident, l.member_id FROM hq.linked_guest_idents() l
     )
     SELECT COALESCE(''u:'' || linked.member_id::text, s.ident), s.user_id, s.at,
            CASE WHEN linked.member_id IS NOT NULL THEN s.ident END
       FROM (' || q || ') s (ident, user_id, at)
       LEFT JOIN linked ON s.user_id IS NULL AND linked.ident = s.ident'
    USING p_from, p_to;
END;
$$;

CREATE OR REPLACE FUNCTION hq.activity_source(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ident text, user_id uuid, at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = hq, public, pg_temp
AS $$
BEGIN
  RETURN QUERY SELECT s.ident, s.user_id, s.at FROM hq.activity_source_linked(p_from, p_to) s;
END;
$$;

-- Recomputes the rollup for Tbilisi days [p_from, p_to]. Returns rows written. A day with both guest and member play
-- of one person keeps the member's user_id.
CREATE OR REPLACE FUNCTION hq.refresh_activity_days(p_from date, p_to date)
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
  DELETE FROM hq.activity_day_merges WHERE day BETWEEN p_from AND p_to;
  WITH agg AS (
    SELECT (s.at AT TIME ZONE 'Asia/Tbilisi')::date AS day, s.ident,
           (array_agg(s.user_id) FILTER (WHERE s.user_id IS NOT NULL))[1] AS user_id,
           array_agg(s.guest_ident) FILTER (WHERE s.guest_ident IS NOT NULL) AS guest_idents
      FROM hq.activity_source_linked(p_from::timestamp AT TIME ZONE 'Asia/Tbilisi',
                                     (p_to + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi') s
     GROUP BY 1, 2
  ), merges AS (
    INSERT INTO hq.activity_day_merges (day, guest_ident, ident)
    SELECT DISTINCT agg.day, g.guest_ident, agg.ident FROM agg, unnest(agg.guest_idents) AS g(guest_ident)
  )
  INSERT INTO hq.activity_days (day, ident, user_id)
  SELECT agg.day, agg.ident, agg.user_id FROM agg;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Re-rolls up to p_max_days retained days (newest first) whose rollup no longer matches the links: a guest ident that
-- now resolves to a member, or a guest ident merged into a member it no longer resolves to (a later conflicting link,
-- the member deleted). Also drops merge provenance older than the retained range. Returns the days refreshed; a
-- refreshed day has nothing stale left, so calling again is a no-op until links change. Takes the rollup lock (waits at most lock_timeout); the caller runs it in its own transaction
-- and bounds it with statement_timeout (see hq.repo.ts).
-- Default 4 days: on a synthetic production-sized rollup a refresh call costs ~1 s plus ~50 ms a day, so a batch takes
-- ~1.4 s (consecutive days) to ~4.5 s (four scattered days) and the 96 retained days take 24 batches.
CREATE FUNCTION hq.reconcile_linked_guest_days(p_max_days integer DEFAULT 4)
RETURNS integer
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  v_days date[];
  r record;
BEGIN
  IF p_max_days IS NULL OR p_max_days < 1 OR current_setting('transaction_read_only') = 'on' THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hq.activity_days'));
  -- Provenance is only read inside the retained range; refreshes of older days (e.g. retention backfills) re-add it.
  DELETE FROM hq.activity_day_merges WHERE day < v_today - 95;
  WITH linked AS MATERIALIZED (
    SELECT l.ident, 'u:' || l.member_id::text AS member_ident FROM hq.linked_guest_idents() l
  )
  SELECT array_agg(s.day) INTO v_days
    FROM (
      SELECT DISTINCT x.day
        FROM (SELECT ad.day
                FROM hq.activity_days ad
               WHERE ad.day BETWEEN v_today - 95 AND v_today
                 AND EXISTS (SELECT 1 FROM linked l WHERE l.ident = ad.ident)
              UNION ALL
              SELECT m.day
                FROM hq.activity_day_merges m
               WHERE m.day BETWEEN v_today - 95 AND v_today
                 AND NOT EXISTS (SELECT 1 FROM linked l WHERE l.ident = m.guest_ident AND l.member_ident = m.ident)) x
       ORDER BY x.day DESC
       LIMIT p_max_days
    ) s;
  -- One refresh per run of consecutive days: most of a refresh's cost is per call, not per day.
  FOR r IN
    SELECT min(x.day) AS d_from, max(x.day) AS d_to
      FROM (SELECT d.day, d.day - (row_number() OVER (ORDER BY d.day))::int AS run
              FROM unnest(v_days) AS d(day)) x
     GROUP BY x.run
     ORDER BY 2 DESC
  LOOP
    PERFORM hq.refresh_activity_days(r.d_from, r.d_to);
  END LOOP;
  RETURN COALESCE(cardinality(v_days), 0);
END;
$$;

ALTER TABLE hq.activity_day_merges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION hq.linked_guest_idents() FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.activity_source_linked(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.reconcile_linked_guest_days(integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON hq.activity_day_merges TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.linked_guest_idents() TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.activity_source_linked(timestamptz, timestamptz) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.reconcile_linked_guest_days(integer) TO service_role';
  END IF;
END $$;
