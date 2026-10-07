-- Freecroco CMS overview and staff accounts (internal API §2): day-range indexes for the overview's counts, and who
-- added each staff membership. The partner tables are new and small, so plain index builds hold their locks only
-- briefly; users is not touched (no foreign key on created_by, which would lock it).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Plays, active players and per-game counts by partner day.
CREATE INDEX IF NOT EXISTS idx_partner_plays_day
  ON public.partner_plays (partner_slug, environment, partner_day);
-- New players by day.
CREATE INDEX IF NOT EXISTS idx_partner_players_created
  ON public.partner_players (partner_slug, environment, created_at);
-- Points sent and delivery counts by day.
CREATE INDEX IF NOT EXISTS idx_partner_score_events_occurred
  ON public.partner_score_events (partner_slug, environment, occurred_at);

-- Nullable, no default: a metadata-only change. NULL for memberships made before this release.
ALTER TABLE public.partner_operator_memberships ADD COLUMN IF NOT EXISTS created_by uuid;
