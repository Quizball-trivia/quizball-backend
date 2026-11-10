-- HQ: content runway data + three new agents (Daily Games Checker, Content QA,
-- Community Manager), created paused; switch them on in the CMS.

-- How much scheduled content each daily game has left (Tbilisi days). One row
-- per game table that exists here: last scheduled day, days left from today,
-- and days missing in the next two weeks.
CREATE FUNCTION hq.daily_coverage()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, hq, pg_temp
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  v_games text[] := ARRAY['dato_falso', 'pistas', 'conexiones', 'ultimo', 'darts501', 'minuto', 'shared_player',
                          'name_chain', 'buscaminas', 'codenames', 'football_race', 'grid_daily', 'tenable', 'draft'];
  g text;
  v_last date;
  v_missing integer;
  v_first_gap date;
  v_out jsonb := '[]'::jsonb;
BEGIN
  FOREACH g IN ARRAY v_games LOOP
    IF to_regclass(format('public.%I', g || '_days')) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('SELECT max(day) FROM public.%I', g || '_days') INTO v_last;
    EXECUTE format(
      'SELECT count(*), min(d::date) FROM generate_series($1, $1 + 13, interval ''1 day'') d
        WHERE NOT EXISTS (SELECT 1 FROM public.%I x WHERE x.day = d::date)', g || '_days')
      INTO v_missing, v_first_gap USING v_today;
    v_out := v_out || jsonb_build_object(
      'game', g,
      'last_day', v_last,
      'days_left', CASE WHEN v_last IS NULL THEN 0 ELSE GREATEST(v_last - v_today + 1, 0) END,
      'missing_next_14_days', v_missing,
      -- the first day players would see no content (a gap, or the day after the last one)
      'runs_out_on', COALESCE(v_first_gap, CASE WHEN v_last IS NULL THEN v_today ELSE v_last + 1 END)
    );
  END LOOP;
  RETURN (SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'days_left')::int, e->>'game'), '[]'::jsonb) FROM jsonb_array_elements(v_out) e);
END;
$$;

REVOKE ALL ON FUNCTION hq.daily_coverage() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.daily_coverage() TO service_role';
  END IF;
END $$;

INSERT INTO hq.members (slug, kind, name, title, avatar, color, department, description, instructions,
                        tools, autonomy, runtime, status, max_turns, role, tier)
VALUES
(
  'daily-games-checker', 'agent', 'Daily Games Checker', 'Content operations', '📅', 'amber', 'content',
  'Watches how many days of content every daily game has left, so no game ever runs out.',
  $i$Every morning, check hq_daily_coverage: for each daily game, the last scheduled day, days left and missing days in the next two weeks.
Report clearly:
- Anything with 7 days or fewer left, or any missing day in the next 14 days, is urgent. Its date is `runs_out_on`. Create ONE task (unassigned, for a person) titled "Content runs out soon" that lists every urgent game with its runs_out_on date and how many days to add, soonest first. If that task is already open (check hq_list_tasks first), post the update on it with hq_post_message instead of creating another.
- 8-21 days left: mention it in your result as "plan soon".
Games without a schedule table aren't covered by the tool; say so instead of guessing.$i$,
  ARRAY['metrics'], 'autonomous', 'hq', 'paused', 15, 'agent', 'read'
),
(
  'content-qa', 'agent', 'Content QA', 'Content quality', '🔍', 'sky', 'content',
  'Checks the question pipeline''s output and what players say about wrong or unclear questions.',
  $i$Check content quality:
1) hq_question_pipeline_stats: jobs, approval and rejection rates, failures in the last 7 days. Flag anything unusual (a drop in approvals, a spike in rejections or failures) with the numbers.
2) hq_feedback: player feedback that points at wrong answers, wrong facts, unclear questions or language problems. Group them by game and language.
3) For each real, specific problem, create one task (unassigned, for a person) with the game, language, the exact player quote and what looks wrong. Check hq_list_tasks first; don't duplicate.
Never invent examples. If there is nothing to flag, say so in one line.$i$,
  ARRAY['metrics', 'feedback', 'web'], 'autonomous', 'hq', 'paused', 20, 'agent', 'read'
),
(
  'community-manager', 'agent', 'Community Manager', 'Community and support', '💬', 'rose', 'growth',
  'Reads player feedback and drafts replies and FAQ answers. Drafts only: nothing is sent.',
  $i$Read player feedback (hq_feedback) and:
1) Group it into themes (bugs, requests, praise, confusion), with counts and the exact quotes.
2) For feedback that deserves an answer, draft a short, friendly reply in the player's language. Drafts only: you cannot send anything, and nothing you write is published.
3) If the same question keeps coming up, draft an FAQ entry.
Put the drafts in your result. If something needs a fix, create a task for the right agent or for a person. Never promise features or dates.$i$,
  ARRAY['feedback', 'web'], 'autonomous', 'hq', 'paused', 20, 'agent', 'read'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO hq.schedules (member_id, name, cron, timezone, task_title, task_body, task_kind, enabled)
SELECT m.id, v.name, v.cron, 'Asia/Tbilisi', v.title, v.body, 'task', true
  FROM hq.members m
  JOIN (VALUES
    ('daily-games-checker', 'Morning content runway', '30 7 * * *', 'Check content runway for every daily game', 'Run the morning content runway check.'),
    ('content-qa', 'Nightly content QA', '15 3 * * *', 'Content quality check', 'Check the question pipeline and player feedback on content.'),
    ('community-manager', 'Daily community digest', '0 10 * * *', 'Community digest and reply drafts', 'Read new player feedback, group it and draft replies.')
  ) AS v(slug, name, cron, title, body) ON v.slug = m.slug
 WHERE NOT EXISTS (SELECT 1 FROM hq.schedules s WHERE s.member_id = m.id AND s.name = v.name);

-- Their daily standup, like every HQ agent's.
INSERT INTO hq.schedules (member_id, name, cron, timezone, task_title, task_body, task_kind)
SELECT m.id, 'Daily standup', '0 8 * * *', 'Asia/Tbilisi', 'Daily standup',
       'Morning standup: report yesterday / today / blockers and propose up to 3 ideas that move the goals.', 'standup'
  FROM hq.members m
 WHERE m.slug IN ('daily-games-checker', 'content-qa', 'community-manager')
ON CONFLICT (member_id) WHERE task_kind = 'standup' DO NOTHING;
