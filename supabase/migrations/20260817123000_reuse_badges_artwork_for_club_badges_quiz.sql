-- The campaign-only Club Badges question category is also returned by the
-- general categories endpoint. Reuse the established Badges and Logos artwork
-- so clients render the current category image instead of their empty-image
-- fallback. The source URL is environment-specific (staging/prod Supabase),
-- therefore copy it from the existing category rather than hard-coding a host.
UPDATE public.categories AS club_badges
SET image_url = badges_and_logos.image_url,
    updated_at = NOW()
FROM public.categories AS badges_and_logos
WHERE club_badges.slug = 'club-badges'
  AND badges_and_logos.slug = 'badges-and-logos'
  AND badges_and_logos.image_url IS NOT NULL;
