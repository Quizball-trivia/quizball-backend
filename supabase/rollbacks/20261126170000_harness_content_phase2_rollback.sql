-- Only safe before any ask/event/proposal rows exist; otherwise archive them first.
DELETE FROM harness.jobs WHERE kind = 'ask';
DELETE FROM harness.agents WHERE slug = 'hq-assistant' AND NOT EXISTS (SELECT 1 FROM harness.runs WHERE agent_slug = 'hq-assistant');
DROP INDEX IF EXISTS harness.harness_jobs_one_live_per_ask;
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_kind, DROP CONSTRAINT IF EXISTS harness_jobs_target, DROP COLUMN IF EXISTS ask_id;
ALTER TABLE harness.jobs
  ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('plan', 'make', 'fact_check', 'quality_judge', 'localize', 'locale_check')),
  ADD CONSTRAINT jobs_check CHECK (item_id IS NOT NULL OR brief_id IS NOT NULL);
DROP TABLE IF EXISTS harness.asks;
ALTER TABLE harness.briefs DROP COLUMN IF EXISTS proposal_id, DROP COLUMN IF EXISTS event_id;
DELETE FROM harness.briefs WHERE source IN ('event', 'seed');
ALTER TABLE harness.briefs DROP CONSTRAINT IF EXISTS briefs_source_check;
ALTER TABLE harness.briefs ADD CONSTRAINT briefs_source_check CHECK (source IN ('health', 'request'));
DROP TABLE IF EXISTS harness.category_proposals;
DROP TABLE IF EXISTS harness.content_events;
