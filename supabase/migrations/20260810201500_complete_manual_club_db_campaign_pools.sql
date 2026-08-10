-- Complete the 5/5/5 campaign pools backed by existing club categories.
--
-- Production has enough verified Arsenal, Chelsea and Manchester City
-- questions, but some category banks do not have five questions carrying each
-- source difficulty label. Prefer the requested source difficulty, then use
-- the closest remaining verified category questions and classify those slots
-- specifically for this public campaign. This matches the established
-- campaign-pool curation behaviour in 20260725120000.

CREATE TEMP TABLE manual_club_pool_fill_candidates ON COMMIT DROP AS
WITH candidates AS (
  SELECT
    configured.quiz_slug,
    question.id AS question_id,
    question.difficulty AS source_difficulty,
    ROW_NUMBER() OVER (
      PARTITION BY
        configured.quiz_slug,
        regexp_replace(lower(question.prompt->>'en'), '[^a-z0-9]', '', 'g')
      ORDER BY md5(question.id::text || configured.quiz_slug)
    ) AS duplicate_rank
  FROM (VALUES
    ('arsenal'),
    ('chelsea'),
    ('manchester-city')
  ) configured(quiz_slug)
  JOIN public.categories category
    ON category.slug = configured.quiz_slug
  JOIN public.questions question
    ON question.category_id = category.id
  JOIN public.question_payloads payload
    ON payload.question_id = question.id
  WHERE question.status = 'published'
    AND question.visibility = 'public'
    AND question.ranked_eligible = TRUE
    AND question.type IN ('mcq_single', 'true_false')
    AND COALESCE(question.prompt->>'en', '') <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM public.campaign_quiz_questions assigned
      WHERE assigned.question_id = question.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.campaign_quiz_questions assigned
      JOIN public.questions assigned_question
        ON assigned_question.id = assigned.question_id
      WHERE assigned.quiz_slug = configured.quiz_slug
        AND regexp_replace(
              lower(assigned_question.prompt->>'en'),
              '[^a-z0-9]',
              '',
              'g'
            ) = regexp_replace(
              lower(question.prompt->>'en'),
              '[^a-z0-9]',
              '',
              'g'
            )
    )
)
SELECT quiz_slug, question_id, source_difficulty
FROM candidates
WHERE duplicate_rank = 1;

WITH existing AS (
  SELECT
    quiz.slug AS quiz_slug,
    COUNT(assigned.question_id) FILTER (
      WHERE assigned.difficulty = 'easy'
    )::int AS existing_count
  FROM public.campaign_quizzes quiz
  LEFT JOIN public.campaign_quiz_questions assigned
    ON assigned.quiz_slug = quiz.slug
  WHERE quiz.slug IN ('arsenal', 'chelsea', 'manchester-city')
  GROUP BY quiz.slug
),
remaining AS (
  SELECT candidate.*
  FROM manual_club_pool_fill_candidates candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.campaign_quiz_questions assigned
    WHERE assigned.question_id = candidate.question_id
  )
),
ranked AS (
  SELECT
    remaining.*,
    existing.existing_count,
    ROW_NUMBER() OVER (
      PARTITION BY remaining.quiz_slug
      ORDER BY
        CASE remaining.source_difficulty
          WHEN 'easy' THEN 0
          WHEN 'medium' THEN 1
          ELSE 2
        END,
        md5(remaining.question_id::text || remaining.quiz_slug)
    ) AS selection_order
  FROM remaining
  JOIN existing USING (quiz_slug)
)
INSERT INTO public.campaign_quiz_questions (
  quiz_slug,
  question_id,
  difficulty,
  display_order
)
SELECT
  quiz_slug,
  question_id,
  'easy',
  existing_count + selection_order
FROM ranked
WHERE selection_order <= 5 - existing_count;

WITH existing AS (
  SELECT
    quiz.slug AS quiz_slug,
    COUNT(assigned.question_id) FILTER (
      WHERE assigned.difficulty = 'medium'
    )::int AS existing_count
  FROM public.campaign_quizzes quiz
  LEFT JOIN public.campaign_quiz_questions assigned
    ON assigned.quiz_slug = quiz.slug
  WHERE quiz.slug IN ('arsenal', 'chelsea', 'manchester-city')
  GROUP BY quiz.slug
),
remaining AS (
  SELECT candidate.*
  FROM manual_club_pool_fill_candidates candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.campaign_quiz_questions assigned
    WHERE assigned.question_id = candidate.question_id
  )
),
ranked AS (
  SELECT
    remaining.*,
    existing.existing_count,
    ROW_NUMBER() OVER (
      PARTITION BY remaining.quiz_slug
      ORDER BY
        CASE remaining.source_difficulty
          WHEN 'medium' THEN 0
          WHEN 'hard' THEN 1
          ELSE 2
        END,
        md5(remaining.question_id::text || remaining.quiz_slug)
    ) AS selection_order
  FROM remaining
  JOIN existing USING (quiz_slug)
)
INSERT INTO public.campaign_quiz_questions (
  quiz_slug,
  question_id,
  difficulty,
  display_order
)
SELECT
  quiz_slug,
  question_id,
  'medium',
  5 + existing_count + selection_order
FROM ranked
WHERE selection_order <= 5 - existing_count;

WITH existing AS (
  SELECT
    quiz.slug AS quiz_slug,
    COUNT(assigned.question_id) FILTER (
      WHERE assigned.difficulty = 'hard'
    )::int AS existing_count
  FROM public.campaign_quizzes quiz
  LEFT JOIN public.campaign_quiz_questions assigned
    ON assigned.quiz_slug = quiz.slug
  WHERE quiz.slug IN ('arsenal', 'chelsea', 'manchester-city')
  GROUP BY quiz.slug
),
remaining AS (
  SELECT candidate.*
  FROM manual_club_pool_fill_candidates candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.campaign_quiz_questions assigned
    WHERE assigned.question_id = candidate.question_id
  )
),
ranked AS (
  SELECT
    remaining.*,
    existing.existing_count,
    ROW_NUMBER() OVER (
      PARTITION BY remaining.quiz_slug
      ORDER BY
        CASE remaining.source_difficulty
          WHEN 'hard' THEN 0
          WHEN 'medium' THEN 1
          ELSE 2
        END,
        md5(remaining.question_id::text || remaining.quiz_slug)
    ) AS selection_order
  FROM remaining
  JOIN existing USING (quiz_slug)
)
INSERT INTO public.campaign_quiz_questions (
  quiz_slug,
  question_id,
  difficulty,
  display_order
)
SELECT
  quiz_slug,
  question_id,
  'hard',
  10 + existing_count + selection_order
FROM ranked
WHERE selection_order <= 5 - existing_count;

DO $$
DECLARE
  pool RECORD;
BEGIN
  FOR pool IN
    SELECT
      quiz.slug,
      COUNT(assigned.question_id)::int AS total,
      COUNT(assigned.question_id) FILTER (
        WHERE assigned.difficulty = 'easy'
      )::int AS easy,
      COUNT(assigned.question_id) FILTER (
        WHERE assigned.difficulty = 'medium'
      )::int AS medium,
      COUNT(assigned.question_id) FILTER (
        WHERE assigned.difficulty = 'hard'
      )::int AS hard
    FROM public.campaign_quizzes quiz
    LEFT JOIN public.campaign_quiz_questions assigned
      ON assigned.quiz_slug = quiz.slug
    WHERE quiz.slug IN ('arsenal', 'chelsea', 'manchester-city')
    GROUP BY quiz.slug
  LOOP
    IF pool.total <> 15
      OR pool.easy <> 5
      OR pool.medium <> 5
      OR pool.hard <> 5
    THEN
      RAISE EXCEPTION
        'Incomplete campaign pool for %: total %, easy %, medium %, hard %',
        pool.slug,
        pool.total,
        pool.easy,
        pool.medium,
        pool.hard;
    END IF;
  END LOOP;
END $$;

UPDATE public.campaign_quizzes
SET status = 'published',
    updated_at = NOW()
WHERE slug IN ('arsenal', 'chelsea', 'manchester-city');
