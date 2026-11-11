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
  WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Tbilisi')::date AS t),
  new_users AS (
    SELECT id, created_at, is_guest, COALESCE(country, '?') AS country
      FROM public.users
     WHERE created_at > now() - make_interval(days => 2 * d) AND NOT is_ai AND NOT is_seed
  ),
  -- Each new player's first match (any game, not dev) and its Tbilisi day. The cohort: first played on one of the
  -- window's days whose NEXT day is already over (first day <= the day before yesterday), so every player had a
  -- full next day to come back.
  first_game AS (
    SELECT DISTINCT ON (mp.user_id) mp.user_id, m.mode, COALESCE(NULLIF(m.game_variant, ''), '') AS variant, m.status,
           (m.started_at AT TIME ZONE 'Asia/Tbilisi')::date AS day
      FROM new_users nu JOIN public.match_players mp ON mp.user_id = nu.id JOIN public.matches m ON m.id = mp.match_id
     WHERE NOT m.is_dev
     ORDER BY mp.user_id, m.started_at
  ),
  cohort AS (
    SELECT f.* FROM first_game f, today
     WHERE f.day BETWEEN today.t - (d + 1) AND today.t - 2
  ),
  recent AS (
    SELECT m.mode, COALESCE(NULLIF(m.game_variant, ''), '') AS variant, m.status, m.started_at, m.ended_at, m.winner_user_id
      FROM public.matches m
     WHERE m.started_at > now() - make_interval(days => d) AND NOT m.is_dev
  )
  SELECT jsonb_build_object(
    'generated_at', now(), 'days', d, 'timezone', 'Asia/Tbilisi',
    'notes', jsonb_build_object(
      'first_game_comeback', 'New players (signed up in the last ' || 2 * d || ' days) by the game of their first match; came_back_next_day_pct = played any match on the Tbilisi day after their first. Only players whose next day is over. Classic matches only (matches table: ranked, friendly incl. grid/party variants, auction); dailies, rooms and duels are not in it.',
      'bot_wins_pct', 'Share of matches with a recorded winner won by a bot account (draws and matches whose winner record was cleared are not counted).'),
    'signups_by_country', (
      SELECT jsonb_agg(x ORDER BY (x->>'now')::int DESC) FROM (
        SELECT jsonb_build_object('country', country,
                 'now', count(*) FILTER (WHERE created_at > now() - make_interval(days => d)),
                 'previous', count(*) FILTER (WHERE created_at <= now() - make_interval(days => d)),
                 'guests_now', count(*) FILTER (WHERE created_at > now() - make_interval(days => d) AND is_guest)) AS x
          FROM new_users GROUP BY country
         ORDER BY count(*) FILTER (WHERE created_at > now() - make_interval(days => d)) DESC LIMIT 20) t),
    'first_game_comeback', (
      SELECT jsonb_agg(jsonb_build_object('game', game, 'new_players', n, 'came_back_next_day_pct', back,
                                          'first_match_abandoned_pct', ab) ORDER BY n DESC) FROM (
        SELECT c.mode || CASE WHEN c.variant <> '' THEN ':' || c.variant ELSE '' END AS game, count(*) AS n,
               round(100.0 * avg((EXISTS (
                 SELECT 1 FROM public.match_players mp2 JOIN public.matches m2 ON m2.id = mp2.match_id
                  WHERE mp2.user_id = c.user_id AND NOT m2.is_dev
                    AND m2.started_at >= ((c.day + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi')
                    AND m2.started_at <  ((c.day + 2)::timestamp AT TIME ZONE 'Asia/Tbilisi')))::int)) AS back,
               round(100.0 * avg((c.status = 'abandoned')::int)) AS ab
          FROM cohort c GROUP BY 1) t),
    'games', (
      SELECT jsonb_agg(jsonb_build_object('game', game, 'matches', n, 'abandoned_pct', ab, 'median_minutes', med,
                                          'bot_wins_pct', bw) ORDER BY n DESC) FROM (
        SELECT r.mode || CASE WHEN r.variant <> '' THEN ':' || r.variant ELSE '' END AS game, count(*) AS n,
               round(100.0 * avg((r.status = 'abandoned')::int)) AS ab,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.ended_at - r.started_at) / 60)
                      FILTER (WHERE r.status = 'completed' AND r.ended_at IS NOT NULL))::numeric, 1) AS med,
               round(100.0 * avg((u.is_ai)::int) FILTER (WHERE r.winner_user_id IS NOT NULL)) AS bw
          FROM recent r LEFT JOIN public.users u ON u.id = r.winner_user_id
         GROUP BY 1) t),
    'daily_active_players', (
      SELECT jsonb_agg(jsonb_build_object('day', g.dd::date, 'players', hq.active_identities_between(g.dd::date, g.dd::date)) ORDER BY g.dd)
        FROM today, generate_series(today.t - (2 * d - 1), today.t, interval '1 day') g(dd)),
    'matches_by_game_day', (
      SELECT jsonb_object_agg(day, games ORDER BY day) FROM (
        SELECT day, jsonb_object_agg(game, n) AS games FROM (
          SELECT (m.started_at AT TIME ZONE 'Asia/Tbilisi')::date AS day,
                 m.mode || CASE WHEN COALESCE(m.game_variant, '') <> '' THEN ':' || m.game_variant ELSE '' END AS game,
                 count(*) AS n
            FROM public.matches m, today
           WHERE m.started_at >= ((today.t - (2 * d - 1))::timestamp AT TIME ZONE 'Asia/Tbilisi') AND NOT m.is_dev
           GROUP BY 1, 2) z
         GROUP BY day) t)
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
