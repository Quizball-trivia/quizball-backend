-- The Content tab's steering controls (HQ, straight to prod).
--   steering:   per-category priority (boost / normal / hold) and a direction
--               note the Planner and the Question Maker read on every brief.
--   briefs:     a person can order questions (source = 'request') with a
--               topic and an optional deadline.
--   policies:   content.direction is the direction note for every category.
-- Flagging, approving, rejecting and sending back items go through
-- harness.transition from the backend; nothing new is needed for them here.

CREATE TABLE harness.steering (
  category_id  uuid PRIMARY KEY REFERENCES public.categories(id) ON DELETE CASCADE,
  priority     text NOT NULL DEFAULT 'normal' CHECK (priority IN ('boost', 'normal', 'hold')),
  direction    text NOT NULL DEFAULT '' CHECK (length(direction) <= 1000),
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE harness.steering ENABLE ROW LEVEL SECURITY;

ALTER TABLE harness.briefs
  ADD COLUMN source       text NOT NULL DEFAULT 'health' CHECK (source IN ('health', 'request')),
  ADD COLUMN topic        text CHECK (length(topic) <= 300),
  ADD COLUMN deadline     date,
  ADD COLUMN requested_by text;
CREATE INDEX harness_briefs_requests ON harness.briefs (created_at DESC) WHERE source = 'request';

INSERT INTO harness.policies (key, value, note) VALUES
  ('content.direction', '""', 'Direction for every category, read by the Planner and the Question Maker')
ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON harness.steering TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
