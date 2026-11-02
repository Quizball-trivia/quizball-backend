-- QuizBall HQ v2: departments + company pulse.
--
-- The CMS is organised as a company: every member (person or agent) belongs
-- to one department, and the command center shows a "pulse" of the business.
-- The department list is a fixed code constant (backend hq.schemas.ts + CMS);
-- keep the CHECK below in sync with it.

ALTER TABLE hq.members
  ADD COLUMN department text NOT NULL DEFAULT 'leadership'
  CONSTRAINT hq_members_department
  CHECK (department IN ('leadership', 'growth', 'content', 'competitions', 'engineering', 'partners'));

CREATE INDEX hq_members_department_idx ON hq.members (department) WHERE status <> 'archived';

-- Seeded agents → their departments (people stay in Leadership by default).
UPDATE hq.members m
   SET department = d.department, updated_at = now()
  FROM (VALUES
    ('ops-reporter',         'leadership'),
    ('reviews-analyst',      'growth'),
    ('growth-writer',        'growth'),
    ('social-media-manager', 'growth'),
    ('question-writer',      'content'),
    ('bug-fixer',            'engineering'),
    ('qa-tester',            'engineering')
  ) AS d(slug, department)
 WHERE m.slug = d.slug;

-- Company pulse for the command center: the daily metrics plus a feedback
-- summary (this week vs the week before). Feedback recency is judged by
-- updated_at, like hq.recent_feedback (a resubmission only advances it).
CREATE FUNCTION hq.pulse(p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = hq, public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'metrics', hq.metrics_snapshot(p_days),
    'feedback', (
      SELECT jsonb_build_object(
        'count_7d',           count(*) FILTER (WHERE g.updated_at >= now() - interval '7 days'),
        'avg_rating_7d',      round(avg(g.rating) FILTER (WHERE g.updated_at >= now() - interval '7 days'), 2),
        'low_ratings_7d',     count(*) FILTER (WHERE g.updated_at >= now() - interval '7 days' AND g.rating <= 2),
        'count_prev_7d',      count(*) FILTER (WHERE g.updated_at < now() - interval '7 days'),
        'avg_rating_prev_7d', round(avg(g.rating) FILTER (WHERE g.updated_at < now() - interval '7 days'), 2)
      )
      FROM public.game_feedback g
      WHERE g.updated_at >= now() - interval '14 days'
    )
  );
$$;

REVOKE ALL ON FUNCTION hq.pulse(integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.pulse(integer) TO service_role';
  END IF;
END $$;
