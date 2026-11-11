-- Growth Analyst (owner, 2026-11-11): an agent that finds why players come and why they leave, per country and per
-- game, and brings Romero concrete ideas to grow daily active players (North Star: 5,000).
--
-- hq.growth_report(): aggregates only (no player rows): sign-ups by country against the previous window, each
-- game's new players (by the game they started with) and how many came back the next day, abandoned share and match
-- length per mode, who wins (people or bots) per mode, daily active players and matches per mode per day.

CREATE FUNCTION hq.growth_report(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '90s'
SET lock_timeout = '2s'
AS $$
DECLARE
  d integer := LEAST(GREATEST(COALESCE(p_days, 7), 1), 28);
  v jsonb;
BEGIN
  WITH new_users AS (
    SELECT id, created_at, is_guest, COALESCE(country, '?') AS country
      FROM public.users
     WHERE created_at > now() - make_interval(days => 2 * d) AND NOT is_ai AND NOT is_seed
  ),
  -- new players of the window (not today: the next day must be over) and the game they started with
  cohort AS (
    SELECT id FROM new_users WHERE created_at > now() - make_interval(days => d + 1) AND created_at <= now() - interval '1 day'
  ),
  first_game AS (
    SELECT DISTINCT ON (mp.user_id) mp.user_id, m.mode, m.status, m.started_at, m.ended_at
      FROM cohort c JOIN public.match_players mp ON mp.user_id = c.id JOIN public.matches m ON m.id = mp.match_id
     WHERE NOT m.is_dev
     ORDER BY mp.user_id, m.started_at
  ),
  recent AS (
    SELECT m.mode, m.status, m.started_at, m.ended_at, m.winner_user_id
      FROM public.matches m
     WHERE m.started_at > now() - make_interval(days => d) AND NOT m.is_dev
  )
  SELECT jsonb_build_object(
    'generated_at', now(), 'days', d, 'timezone', 'Asia/Tbilisi',
    'signups_by_country', (
      SELECT jsonb_agg(x ORDER BY (x->>'now')::int DESC) FROM (
        SELECT jsonb_build_object('country', country,
                 'now', count(*) FILTER (WHERE created_at > now() - make_interval(days => d)),
                 'previous', count(*) FILTER (WHERE created_at <= now() - make_interval(days => d)),
                 'guests_now', count(*) FILTER (WHERE created_at > now() - make_interval(days => d) AND is_guest)) AS x
          FROM new_users GROUP BY country
         ORDER BY count(*) FILTER (WHERE created_at > now() - make_interval(days => d)) DESC LIMIT 20) t),
    'first_game_comeback', (
      SELECT jsonb_agg(jsonb_build_object('mode', mode, 'new_players', n, 'came_back_next_day_pct', back,
                                          'first_match_abandoned_pct', ab) ORDER BY n DESC) FROM (
        SELECT f.mode, count(*) AS n,
               round(100.0 * avg((EXISTS (SELECT 1 FROM public.match_players mp2 JOIN public.matches m2 ON m2.id = mp2.match_id
                                           WHERE mp2.user_id = f.user_id AND m2.started_at > f.started_at + interval '20 hours'))::int)) AS back,
               round(100.0 * avg((f.status = 'abandoned')::int)) AS ab
          FROM first_game f GROUP BY f.mode) t),
    'modes', (
      SELECT jsonb_agg(jsonb_build_object('mode', mode, 'matches', n, 'abandoned_pct', ab, 'median_minutes', med,
                                          'bot_wins_pct', bw) ORDER BY n DESC) FROM (
        SELECT r.mode, count(*) AS n,
               round(100.0 * avg((r.status = 'abandoned')::int)) AS ab,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.ended_at - r.started_at) / 60)
                      FILTER (WHERE r.status = 'completed' AND r.ended_at IS NOT NULL))::numeric, 1) AS med,
               round(100.0 * avg((u.is_ai)::int) FILTER (WHERE r.winner_user_id IS NOT NULL)) AS bw
          FROM recent r LEFT JOIN public.users u ON u.id = r.winner_user_id
         GROUP BY r.mode) t),
    'daily_active_players', (
      SELECT jsonb_agg(jsonb_build_object('day', day, 'players', hq.active_identities_between(day, day)) ORDER BY day)
        FROM generate_series(((now() AT TIME ZONE 'Asia/Tbilisi')::date - (2 * d - 1)), (now() AT TIME ZONE 'Asia/Tbilisi')::date, interval '1 day') g(dd),
             LATERAL (SELECT g.dd::date AS day) x),
    'matches_by_mode_day', (
      SELECT jsonb_object_agg(day, modes ORDER BY day) FROM (
        SELECT (started_at AT TIME ZONE 'Asia/Tbilisi')::date AS day, jsonb_object_agg(mode, n) AS modes
          FROM (SELECT started_at, mode, count(*) OVER (PARTITION BY (started_at AT TIME ZONE 'Asia/Tbilisi')::date, mode) AS n FROM recent) z
         GROUP BY 1) t)
  ) INTO v;
  RETURN v;
END;
$$;

INSERT INTO hq.members (slug, kind, name, title, avatar, color, department, description, instructions,
                        tools, autonomy, runtime, status, max_turns, role, tier, model, effort)
VALUES (
  'growth-analyst', 'agent', 'Growth Analyst', 'Growth and retention', '📈', 'emerald', 'growth',
  'Finds why players come and why they leave, per country, page and game, and brings Romero ideas to grow daily active players.',
  $i$Your goal is the North Star: 5,000 daily active players. You find what moves it and bring Romero concrete, proven ideas.
Each run:
1) What changed: hq_growth_report (sign-ups by country against the previous window, daily active players, matches per game per day) and, when you have it, hq_posthog_query (where visitors come from: country, referrer, landing page; what they do next). Spikes and drops in the last 7-8 days come first: who are these people, where from, why now (Google searches, a YouTube trend, a new page or game)?
2) Where they leave: for each game, the funnel from landing page → play → first minute → finished match → came back next day (first_game_comeback, PostHog events). Find the biggest leaks: the game that brings the most new players but keeps the fewest is the biggest opportunity.
3) Why: evidence, not guesses. Numbers from your tools, the page and the game as a new player sees them, what the players were searching for (web search: Google suggestions, YouTube videos in their language), player feedback (hq_feedback). Be 100% sure before you call something a finding; label the rest "to check".
   Learn from others: how other football and quiz games (and the web games and YouTube formats our players come from) keep players: onboarding, the first minute, match length, streaks, daily goals, rewards, friends. Bring what fits QuizBall, with the source.
4) Ideas: up to 3 a run, each concrete (what to change in which game or page, for whom), with the evidence, the expected effect on daily active players (a number and how you estimated it) and how to measure it. Small, testable changes first (onboarding, the first minute of a game, match length for new players, a missing event to measure a funnel). Propose them with hq_propose; Romero decides and starts the builds.
5) hq_finish: what changed, where players leave, the ideas (with task numbers), the numbers that matter. No filler.
You never change anything yourself.$i$,
  ARRAY['growth', 'metrics', 'feedback', 'web'], 'autonomous', 'hq', 'paused', 60, 'agent', 'read', 'claude-opus-5-5', 'high'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO hq.schedules (member_id, name, cron, timezone, task_title, task_body, task_kind, enabled)
SELECT m.id, v.name, v.cron, 'Asia/Tbilisi', v.title, v.body, 'task', true
  FROM hq.members m
  JOIN (VALUES
    ('Daily growth scan', '30 8 * * *', 'Daily growth scan',
     'What changed in the last days (countries, sources, pages, games), where new players leave, and up to 3 ideas for Romero.'),
    ('Afternoon growth check', '30 16 * * *', 'Afternoon growth check',
     'Today so far: any spike or drop by country, page or game, and the leak behind it; follow up on the morning''s ideas.'),
    ('Weekly stickiness review', '0 11 * * 1', 'Weekly stickiness review',
     'For every game: how many new players it brings, how many come back, where they leave and why; ideas to make each game stickier.')
  ) AS v(name, cron, title, body) ON m.slug = 'growth-analyst'
 WHERE NOT EXISTS (SELECT 1 FROM hq.schedules s WHERE s.member_id = m.id AND s.name = v.name);

REVOKE ALL ON FUNCTION hq.growth_report(integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.growth_report(integer) TO service_role';
  END IF;
END $$;
