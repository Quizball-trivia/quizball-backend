-- HQ builds: which game a build is about, and where its play-test screenshots live.
--
-- 1. build_requests.game — optional game id (the analytics mode id, e.g. "room_tenable"), so HQ can show the game's
--    plays before and after the build shipped without guessing from the title.
-- 2. submit_build_request takes the game (a sixth argument, default null, so a 5-argument call still resolves).
-- 3. A private storage bucket for the Builder's play-test screenshots (phone and desktop, before and after). The
--    worker uploads with the service role; the backend hands the CMS short-lived signed links. Never public.

ALTER TABLE hq.build_requests ADD COLUMN game text
  CHECK (game IS NULL OR game ~ '^[A-Za-z0-9_:-]{1,60}$');

DROP FUNCTION hq.submit_build_request(uuid, text, text, text, text[]);

CREATE FUNCTION hq.submit_build_request(p_human uuid, p_title text, p_spec text, p_kind text, p_repos text[], p_game text DEFAULT NULL)
RETURNS hq.build_requests
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  h hq.members;
  d hq.members;
  r hq.build_requests;
  t uuid;
  v_today timestamptz := ((now() AT TIME ZONE 'Asia/Tbilisi')::date)::timestamp AT TIME ZONE 'Asia/Tbilisi';
BEGIN
  SELECT * INTO h FROM hq.members WHERE id = p_human FOR SHARE;
  IF h.id IS NULL OR h.kind <> 'human' OR h.status <> 'active' OR NOT (h.is_founder OR h.can_request_builds) THEN
    RAISE EXCEPTION 'only the founder (or someone the founder allowed) can ask for a build' USING ERRCODE = 'P0001';
  END IF;
  -- One request at a time per person is serialised, so the daily cap holds under concurrent calls.
  PERFORM pg_advisory_xact_lock(hashtext('hq.build_request:' || p_human::text));
  IF (SELECT count(*) FROM hq.build_requests WHERE requested_by = p_human AND created_at >= v_today) >= 10 THEN
    RAISE EXCEPTION 'that is 10 build requests today; the Director has enough to review' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO d FROM hq.members WHERE role = 'director' AND status = 'active' ORDER BY created_at LIMIT 1;
  INSERT INTO hq.build_requests (requested_by, title, spec, kind, repos, game)
  VALUES (p_human, btrim(p_title), p_spec, p_kind, (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_repos) AS x), NULLIF(btrim(p_game), ''))
  RETURNING * INTO r;
  -- The Director reviews it as a task of his own (read-only work: he decides with hq_decide_build).
  IF d.id IS NOT NULL THEN
    INSERT INTO hq.tasks (title, body, status, priority, kind, assignee_id, created_by_id, ref)
    VALUES (left('Review build request #' || r.number || ': ' || r.title, 200),
            'Build request #' || r.number || ' from ' || h.name || '. Read it with hq_build_requests and decide it with hq_decide_build.',
            'todo', 1, 'task', d.id, h.id, jsonb_build_object('build_request', r.id))
    RETURNING id INTO t;
    UPDATE hq.build_requests SET review_task_id = t WHERE id = r.id RETURNING * INTO r;
  END IF;
  INSERT INTO hq.events (type, member_id, message, data)
  VALUES ('build_requested', h.id, left(h.name || ' asked for a build: #' || r.number || ' ' || r.title, 500),
          jsonb_build_object('request_id', r.id, 'kind', r.kind, 'repos', r.repos, 'game', r.game));
  RETURN r;
END;
$$;

REVOKE ALL ON FUNCTION hq.submit_build_request(uuid, text, text, text, text[], text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.submit_build_request(uuid, text, text, text, text[], text) TO service_role';
  END IF;
END $$;

-- Guarded: a bare Postgres (the SQL test cluster) has no storage schema.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('hq-builds', 'hq-builds', false, 5242880, ARRAY['image/png'])
    ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;
  END IF;
END $$;
