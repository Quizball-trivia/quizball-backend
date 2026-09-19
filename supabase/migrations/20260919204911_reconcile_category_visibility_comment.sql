-- Preserve environment-local editorial visibility. The historical SEO category
-- deactivation is archived rather than replayed against newer production edits.
-- campaign_only independently excludes campaign content from matchmaking.
COMMENT ON COLUMN public.categories.is_active IS
  'Controls category visibility. Matchmaking also excludes campaign_only categories; campaign page publication is controlled separately by campaign_quizzes.status.';
