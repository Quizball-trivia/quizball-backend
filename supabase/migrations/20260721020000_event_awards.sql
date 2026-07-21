-- Event awards: podium finishes of a concluded event, shown as profile
-- achievements and celebrated once on the winner's next login (seen_at).
-- Seeded from the Season 1 archive per environment, so each env decorates its
-- own real top 3. Idempotent: safe under manual apply + deploy runner re-run.
CREATE TABLE IF NOT EXISTS event_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_slug text NOT NULL,
  place integer NOT NULL CHECK (place BETWEEN 1 AND 3),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz,
  UNIQUE (event_slug, place),
  UNIQUE (event_slug, user_id)
);

CREATE INDEX IF NOT EXISTS event_awards_user_idx ON event_awards (user_id);

ALTER TABLE event_awards ENABLE ROW LEVEL SECURITY;

INSERT INTO event_awards (event_slug, place, user_id)
SELECT 'georgia-world-cup', rn, user_id
FROM (
  SELECT
    a.user_id,
    ROW_NUMBER() OVER (
      ORDER BY a.rp DESC, a.last_ranked_match_at ASC NULLS LAST, a.user_id ASC
    ) AS rn
  FROM ranked_profiles_archive a
  JOIN ranked_reset_batches b ON b.id = a.reset_batch_id AND b.season_number = 1
  JOIN users u ON u.id = a.user_id
  WHERE u.is_ai = false AND u.is_seed = false AND u.is_deleted = false
    AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
    AND a.placement_status = 'placed'
) ranked
WHERE rn <= 3
ON CONFLICT (event_slug, place) DO NOTHING;
