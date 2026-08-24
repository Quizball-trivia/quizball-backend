-- Shadow anti-cheat report: suspicious tab-leave patterns per user.
--
-- Pairs each 'hidden' visibility event with the next 'visible' event by the
-- same user in the same match (an "absence episode"), keeps episodes that
-- overlap an open question, and joins the user's answer to that question.
-- The smoking-gun pattern: absent >= 3s during the question AND a CORRECT
-- answer landing < 1.5s after returning — a human reading the question fresh
-- can't do that; someone pasting from an LLM can.
--
-- Detection-only. Run ad hoc (Georgia time in output) or scope with the
-- :since / :user filters. Requires the match_visibility_events table
-- (migration 20260824200000).

WITH episodes AS (
  SELECT
    h.match_id,
    h.user_id,
    h.q_index,
    h.question_kind,
    h.mode,
    h.occurred_at AS hidden_at,
    v.occurred_at AS visible_at,
    EXTRACT(epoch FROM (v.occurred_at - h.occurred_at)) AS hidden_seconds
  FROM match_visibility_events h
  CROSS JOIN LATERAL (
    SELECT occurred_at
    FROM match_visibility_events v
    WHERE v.match_id = h.match_id
      AND v.user_id = h.user_id
      AND v.signal IN ('visible', 'focus')
      AND v.occurred_at > h.occurred_at
    ORDER BY v.occurred_at
    LIMIT 1
  ) v
  WHERE h.signal = 'hidden'
    AND h.question_open
    AND h.occurred_at > now() - interval '30 days'
),
scored AS (
  SELECT
    e.*,
    ma.is_correct,
    ma.answered_at,
    EXTRACT(epoch FROM (ma.answered_at - e.visible_at)) AS answer_after_return_s
  FROM episodes e
  JOIN match_answers ma
    ON ma.match_id = e.match_id
   AND ma.user_id = e.user_id
   AND ma.q_index = e.q_index
   AND ma.answered_at > e.visible_at
)
SELECT
  u.nickname,
  s.user_id,
  count(*) AS suspicious_episodes,
  count(*) FILTER (WHERE s.question_kind = 'clues') AS on_who_am_i,
  round(avg(s.hidden_seconds)::numeric, 1) AS avg_hidden_s,
  round(avg(s.answer_after_return_s)::numeric, 2) AS avg_answer_after_return_s,
  count(DISTINCT s.match_id) AS matches_affected,
  max(s.hidden_at AT TIME ZONE 'Asia/Tbilisi') AS last_seen_ge
FROM scored s
JOIN users u ON u.id = s.user_id
WHERE s.hidden_seconds >= 3
  AND s.answer_after_return_s BETWEEN 0 AND 1.5
  AND s.is_correct
GROUP BY u.nickname, s.user_id
ORDER BY suspicious_episodes DESC
LIMIT 50;

-- Baseline companion (how often do NORMAL players hide the tab mid-question?):
-- SELECT question_kind, count(*) FILTER (WHERE signal = 'hidden') AS hides,
--        count(DISTINCT user_id) AS users
-- FROM match_visibility_events
-- WHERE question_open AND occurred_at > now() - interval '7 days'
-- GROUP BY question_kind;
