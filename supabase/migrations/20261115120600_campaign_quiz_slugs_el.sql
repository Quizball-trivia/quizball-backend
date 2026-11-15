-- Greek (el) public slugs for the campaign quiz pages, in Greeklish as Greek sites write URLs (docs/SEO-GAME-NAMING-EL-2026-11-13.md):
-- clubs and competitions "<name>-kouiz", national teams "ethniki-<country>-kouiz". Any other page keeps its source slug,
-- as the registry's first backfill did. Insert-only: an existing Greek slug is never changed.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

WITH explicit (quiz_slug, locale, public_slug) AS (
  VALUES
  ('argentina', 'el', 'ethniki-argentinis-kouiz'),
  ('arsenal', 'el', 'arsenal-kouiz'),
  ('aston-villa', 'el', 'aston-villa-kouiz'),
  ('barcelona', 'el', 'barcelona-kouiz'),
  ('bournemouth', 'el', 'bournemouth-kouiz'),
  ('brentford', 'el', 'brentford-kouiz'),
  ('brighton', 'el', 'brighton-kouiz'),
  ('career-path', 'el', 'vres-ton-paikti-apo-tin-kariera'),
  ('chelsea', 'el', 'chelsea-kouiz'),
  ('club-badges', 'el', 'vres-tin-omada-apo-to-sima'),
  ('coventry-city', 'el', 'coventry-city-kouiz'),
  ('crystal-palace', 'el', 'crystal-palace-kouiz'),
  ('everton', 'el', 'everton-kouiz'),
  ('fulham', 'el', 'fulham-kouiz'),
  ('guess-the-player', 'el', 'mantepse-ton-podosfairisti'),
  ('hull-city', 'el', 'hull-city-kouiz'),
  ('ipswich-town', 'el', 'ipswich-town-kouiz'),
  ('la-liga', 'el', 'la-liga-kouiz'),
  ('leeds-united', 'el', 'leeds-united-kouiz'),
  ('liverpool', 'el', 'liverpool-kouiz'),
  ('manchester-city', 'el', 'manchester-city-kouiz'),
  ('manchester-united', 'el', 'manchester-united-kouiz'),
  ('newcastle-united', 'el', 'newcastle-united-kouiz'),
  ('nottingham-forest', 'el', 'nottingham-forest-kouiz'),
  ('premier-league', 'el', 'premier-league-kouiz'),
  ('real-madrid', 'el', 'real-madrid-kouiz'),
  ('spain', 'el', 'ethniki-ispanias-kouiz'),
  ('sunderland', 'el', 'sunderland-kouiz'),
  ('tottenham', 'el', 'tottenham-kouiz')
)
INSERT INTO public.campaign_quiz_slugs (quiz_slug, locale, public_slug)
SELECT page.slug, 'el', COALESCE(explicit.public_slug, page.slug)
FROM public.campaign_quizzes page
LEFT JOIN explicit ON explicit.quiz_slug = page.slug
ON CONFLICT DO NOTHING;
