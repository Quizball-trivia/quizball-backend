-- Games hub, step 2, second half (HQ, straight to prod): building a planned change.
-- A person presses "Build it" on a plan they have read. HQ starts a GitHub
-- Actions run in each repository the plan touches (website, server); an agent
-- writes the change there on top of staging and the run pushes a branch. HQ
-- opens the pull request into staging and, once a person approves, merges it.

ALTER TABLE harness.game_changes
  -- Which build this is. A rebuild gets a new one, so a late answer about an old build is ignored.
  ADD COLUMN build_id         text CHECK (build_id ~ '^[a-f0-9]{8,32}$'),
  ADD COLUMN build_started_at timestamptz,
  -- One entry per part, keyed 'web' or 'backend':
  -- {state: starting|running|ready|failed, runId, runUrl, headSha, prNumber, prUrl, previewUrl, error, builtAt, mergedAt}
  ADD COLUMN builds           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(builds) = 'object'),
  -- Set while an approval is merging on GitHub: nothing else may rebuild or drop the change until it has saved its outcome.
  ADD COLUMN approving_until  timestamptz;

CREATE INDEX harness_game_changes_building ON harness.game_changes (updated_at) WHERE status IN ('building', 'ready');

NOTIFY pgrst, 'reload schema';
