-- SEO landing pages can own categories solely to satisfy the questions table's
-- category foreign key. Those categories are content containers, not ranked
-- gameplay categories, and must remain hidden from the player category picker.
--
-- A slug can also refer to an established category (Liverpool, Arsenal,
-- Premier League, etc.) with a separate ranked bank. Preserve those categories
-- as active; their campaign-reserved questions are already protected by
-- questions.ranked_eligible = FALSE.

UPDATE public.categories category
SET
  is_active = FALSE,
  updated_at = NOW()
WHERE category.is_active = TRUE
  AND EXISTS (
    SELECT 1
    FROM public.campaign_quizzes quiz
    WHERE quiz.slug = category.slug
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.questions ranked_question
    WHERE ranked_question.category_id = category.id
      AND ranked_question.status = 'published'
      AND ranked_question.visibility = 'public'
      AND ranked_question.ranked_eligible = TRUE
  );

COMMENT ON COLUMN public.categories.is_active IS
  'Controls gameplay/category visibility. SEO-only campaign categories remain false; campaign page publication is controlled separately by campaign_quizzes.status.';
