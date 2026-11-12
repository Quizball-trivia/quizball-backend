-- Growth report: why new players leave, per country (build #7, 2026-11-12). Every key of hq.growth_report keeps its
-- meaning; it adds:
--   first_game_breakdown: the first_game_comeback cohort by country (top 10, then 'other'; no country '?'), first game,
--     first-match result and guest/registered, with next-day return both as today (a classic match) and as ANY game
--     the North Star counts (hq.activity_days, the rollup of hq.activity_source: dailies, rooms, duels, Weekend
--     League). Cells under 10 players are pooled into one 'other' row.
--   auction_recording_check: what the matches table records for Auction (status, ended_at, length).
--
-- First-match result, per mode (the most reliable record each one has):
--   Grid (friendly:football_grid): football_grid_matches.status: 'forfeited' = the non-winner forfeited (left);
--     'cancelled' = no contest (loading no-show, both disconnected, admin cancel; matches.status 'abandoned', who
--     caused it is not recorded): left; 'completed' by matches.winner_user_id.
--   Ranked / Friendly (possession): matches.winner_user_id; a forfeit completes the match for the opponent (or with
--     no winner when both forfeited) with state_payload.winnerDecisionMethod = 'forfeit', so a non-winner of such a
--     match left. An abandoned match is left, except when ranked_early_forfeit_events (per player) shows only the
--     opponent forfeited early: no winner, draw.
--   Party (friendly:friendly_party_quiz): matches.winner_user_id; a player in state_payload.droppedUserIds (their
--     own forfeit or a disconnect timeout, per player) left.
--   Auction: match_players.placement with matches.winner_user_id (the writer sets it only for a sole 1st: a 1st
--     without it is a shared 1st, a draw). Rows are written only when the match finishes and quits are not persisted
--     (a quitter is ranked last), so a quit counts as a loss.
--   Any mode: a match not completed (abandoned / still active) is left; lost_to_bot when the winner (Auction: a
--   1st-placed seat, or none left, as cleanup_ai_users deletes old Auction bots' seats) is a users.is_ai account.

CREATE OR REPLACE FUNCTION hq.growth_report(p_days integer DEFAULT 7)
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
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  v_any_known boolean;
BEGIN
  -- In its own statement: rollup rows written while the report's query runs would not be visible to that query.
  PERFORM hq.ensure_activity_days(v_today - (2 * d - 1));
  v_any_known := hq.activity_covered(v_today - d);

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
           (m.started_at AT TIME ZONE 'Asia/Tbilisi')::date AS day, m.id AS match_id
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
  ),
  -- One row per cohort player; what the narrow cohort leaves out is looked up by key. ident: the player's identity in
  -- hq.activity_source (registered 'u:<id>'; a guest account its linked guest session 'g:<session>', else
  -- 'a:<id>'; a deleted account none).
  cohort_players AS (
    SELECT c.user_id, c.day, u.is_guest, COALESCE(u.country, '?') AS country,
           c.mode || CASE WHEN c.variant <> '' THEN ':' || c.variant ELSE '' END AS game,
           CASE
             WHEN u.is_deleted THEN NULL
             WHEN NOT u.is_guest THEN 'u:' || c.user_id::text
             ELSE COALESCE('g:' || (SELECT ui.subject FROM public.user_identities ui
                                     WHERE ui.user_id = c.user_id AND ui.provider = 'guest'
                                     ORDER BY ui.created_at LIMIT 1),
                           'a:' || c.user_id::text)
           END AS ident,
           CASE
             WHEN c.variant = 'football_grid' AND g.status IN ('forfeited', 'cancelled') THEN
               CASE WHEN m.winner_user_id = c.user_id THEN 'won' ELSE 'left' END
             WHEN c.status IS DISTINCT FROM 'completed' THEN
               CASE WHEN c.mode = 'ranked'
                         AND NOT EXISTS (SELECT 1 FROM public.ranked_early_forfeit_events e
                                          WHERE e.match_id = c.match_id AND e.user_id = c.user_id)
                         AND EXISTS (SELECT 1 FROM public.ranked_early_forfeit_events e
                                      WHERE e.match_id = c.match_id AND e.user_id <> c.user_id)
                    THEN 'draw' ELSE 'left' END
             -- The writer sets winner_user_id only for a sole 1st, and cleanup_ai_users deletes old Auction bots (their
             -- seats go, a winner record is cleared): a 1st with no winner is a shared 1st, and no 1st seat left means
             -- a bot came 1st.
             WHEN c.mode = 'auction' THEN
               CASE WHEN mp.placement = 1 THEN CASE WHEN m.winner_user_id = c.user_id THEN 'won' ELSE 'draw' END
                    WHEN (SELECT bool_and(NOT b.is_ai) FROM public.match_players p JOIN public.users b ON b.id = p.user_id
                           WHERE p.match_id = c.match_id AND p.placement = 1) THEN 'lost_to_human'
                    ELSE 'lost_to_bot' END
             WHEN m.winner_user_id = c.user_id THEN 'won'
             WHEN m.state_payload->>'winnerDecisionMethod' = 'forfeit'
                  OR (c.variant = 'friendly_party_quiz' AND m.state_payload->'droppedUserIds' ? c.user_id::text)
               THEN 'left'
             WHEN m.winner_user_id IS NULL THEN 'draw'
             WHEN w.is_ai THEN 'lost_to_bot'
             ELSE 'lost_to_human'
           END AS result,
           EXISTS (
             SELECT 1 FROM public.match_players mp2 JOIN public.matches m2 ON m2.id = mp2.match_id
              WHERE mp2.user_id = c.user_id AND NOT m2.is_dev
                AND m2.started_at >= ((c.day + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi')
                AND m2.started_at <  ((c.day + 2)::timestamp AT TIME ZONE 'Asia/Tbilisi')) AS back_match
      FROM cohort c
      JOIN public.users u ON u.id = c.user_id
      JOIN public.matches m ON m.id = c.match_id
      JOIN public.match_players mp ON mp.match_id = c.match_id AND mp.user_id = c.user_id
      LEFT JOIN public.users w ON w.id = m.winner_user_id
      LEFT JOIN public.football_grid_matches g ON g.match_id = c.match_id AND c.variant = 'football_grid'
  ),
  top_countries AS (
    SELECT country FROM cohort_players WHERE country <> '?' GROUP BY country ORDER BY count(*) DESC, country LIMIT 10
  ),
  cells AS (
    SELECT CASE WHEN p.country = '?' OR p.country IN (SELECT country FROM top_countries) THEN p.country ELSE 'other' END
             AS country,
           p.game, p.result, p.is_guest, count(*) AS n,
           count(*) FILTER (WHERE p.back_match) AS back_match,
           count(ad.ident) AS back_any
      FROM cohort_players p
      LEFT JOIN hq.activity_days ad ON ad.day = p.day + 1 AND ad.ident = p.ident
     GROUP BY 1, 2, 3, 4
  ),
  -- Cells under 10 players are pooled into one 'other' row (no return rates while it is under 10 too).
  breakdown AS (
    SELECT (n < 10) AS pooled,
           CASE WHEN n < 10 THEN 'other' ELSE country END AS country,
           CASE WHEN n < 10 THEN 'other' ELSE game END AS game,
           CASE WHEN n < 10 THEN 'other' ELSE result END AS result,
           CASE WHEN n < 10 THEN NULL ELSE is_guest END AS is_guest,
           sum(n) AS n, sum(back_match) AS back_match, sum(back_any) AS back_any
      FROM cells
     GROUP BY 1, 2, 3, 4, 5
  )
  SELECT jsonb_build_object(
    'generated_at', now(), 'days', d, 'timezone', 'Asia/Tbilisi',
    'notes', jsonb_build_object(
      'first_game_comeback', 'New players (signed up in the last ' || 2 * d || ' days) by the game of their first match; came_back_next_day_pct = played any match on the Tbilisi day after their first. Only players whose next day is over. Classic matches only (matches table: ranked, friendly incl. grid/party variants, auction); dailies, rooms and duels are not in it.',
      'bot_wins_pct', 'Share of matches with a recorded winner won by a bot account (draws and matches whose winner record was cleared are not counted).',
      'first_game_breakdown', 'The first_game_comeback cohort by country (users.country: the top 10 by cohort size, the rest ''other'', none ''?''), first game (mode:variant), first_match_result and is_guest. came_back_match_next_day_pct is first_game_comeback''s return (a classic match the next Tbilisi day); came_back_any_game_next_day_pct counts ANY game the North Star counts that day (hq.activity_days from hq.activity_source: classic matches, dailies, rooms, duels, Weekend League), registered players as their account, guest accounts as their linked guest session (else the account); null when the activity rollup does not cover those days. Cells under 10 players are pooled into the last row (country, first_game and first_match_result ''other''), whose rates are null while it has under 10 players.',
      'first_match_result', 'For the new player: won, lost_to_bot / lost_to_human (by who won: a users.is_ai account is a bot; Auction: a 1st-placed seat), draw (no winner and they did not leave: a tie, or their ranked match was cancelled by the opponent''s early forfeit) or left (they forfeited, or the match was abandoned with no result). Per mode: Grid by football_grid_matches.status (forfeited: the non-winner left; cancelled, a no contest whose cause is not recorded per player: left); Ranked and Friendly possession by matches.winner_user_id, state_payload.winnerDecisionMethod = forfeit (a non-winner left) and, for abandoned ranked matches, ranked_early_forfeit_events; Party by matches.winner_user_id and state_payload.droppedUserIds (their forfeit or disconnect timeout: left); Auction by match_players.placement and matches.winner_user_id (set only for a sole 1st: a 1st without it is a shared 1st, a draw; a deleted bot''s seat counts as a bot 1st; quits are not recorded: a quitter is ranked last, so counts as lost).',
      'auction_recording_check', 'Auction matches started in the window (not dev): count, count by status, with ended_at set, completed with ended_at missing, median minutes from started_at to ended_at where set. Auction rows are written only when the match finishes (started_at is when it was saved, ended_at milliseconds later), so Auction match length is NOT recorded: this median and the games key''s Auction median_minutes are near 0. Quits are NOT recorded either: status is always completed and a quitter is stored as a normal last placement.'),
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
    'first_game_breakdown', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('country', country, 'first_game', game, 'first_match_result', result,
                                          'is_guest', is_guest, 'new_players', n,
                                          'came_back_match_next_day_pct',
                                            CASE WHEN n >= 10 THEN round(100.0 * back_match / n) END,
                                          'came_back_any_game_next_day_pct',
                                            CASE WHEN n >= 10 AND v_any_known THEN round(100.0 * back_any / n) END)
                       ORDER BY pooled, n DESC, country, game, result, is_guest)
        FROM breakdown), '[]'::jsonb),
    'auction_recording_check', (
      SELECT jsonb_build_object(
               'matches', count(*),
               'by_status', COALESCE((SELECT jsonb_object_agg(s.status, s.n)
                                        FROM (SELECT COALESCE(status, '?') AS status, count(*) AS n
                                                FROM recent WHERE mode = 'auction' GROUP BY 1) s), '{}'::jsonb),
               'with_ended_at', count(*) FILTER (WHERE ended_at IS NOT NULL),
               'completed_without_ended_at', count(*) FILTER (WHERE status = 'completed' AND ended_at IS NULL),
               'median_minutes', round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ended_at - started_at) / 60)
                                        FILTER (WHERE ended_at IS NOT NULL))::numeric, 1))
        FROM recent WHERE mode = 'auction'),
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

REVOKE ALL ON FUNCTION hq.growth_report(integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.growth_report(integer) TO service_role';
  END IF;
END $$;
