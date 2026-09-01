-- SEO campaign-quiz categories were leaking into the ranked draft.
--
-- Matchmaking picks any active category with enough ranked-eligible published
-- questions. The campaign batch created 2026-08-10 for the /football-quiz SEO
-- pages qualified once it had enough questions, so Coventry City, Aston Villa
-- and Sunderland were being offered in real ranked matches (~950 lobbies each
-- in 30 days).
--
-- Slug alone cannot separate them: campaign_quizzes.slug overlaps with genuine
-- ranked categories (premier-league, la-liga, barcelona, real-madrid, ...), all
-- of which must KEEP appearing in matchmaking. So mark the campaign-only ones
-- explicitly.
--
-- The /football-quiz pages are unaffected: they select questions through
-- campaign_quiz_questions (by quiz_slug), never through category matchmaking
-- eligibility.

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS campaign_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.categories.campaign_only IS
  'True for categories that exist only to back an SEO campaign-quiz page. Excluded from ranked/friendly matchmaking; still usable by /football-quiz pages.';

-- Backfill: the 2026-08-10/17 campaign batch ONLY. Established categories that
-- happen to share a slug with a campaign page are deliberately not listed.
UPDATE public.categories
SET campaign_only = true
WHERE slug IN (
  'aston-villa',
  'bournemouth',
  'brentford',
  'brighton',
  'club-badges',
  'coventry-city',
  'crystal-palace',
  'fulham',
  'hull-city',
  'ipswich-town',
  'leeds-united',
  'newcastle-united',
  'nottingham-forest',
  'sunderland'
);

-- Partial index: matchmaking filters on campaign_only = false over the whole
-- category table, so index the small excluded set rather than the common case.
CREATE INDEX IF NOT EXISTS idx_categories_campaign_only
  ON public.categories (id) WHERE campaign_only = true;
