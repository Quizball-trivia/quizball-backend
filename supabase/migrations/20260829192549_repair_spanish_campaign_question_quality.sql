BEGIN;

-- Replace three launch questions found during staging editorial review: one
-- image-dependent prompt and two source/translation mismatches.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL quizball.campaign_quiz_write = 'on';

CREATE TEMP TABLE spanish_campaign_repair_targets (
  quiz_slug TEXT PRIMARY KEY,
  category_slug TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  display_order SMALLINT NOT NULL
) ON COMMIT DROP;

INSERT INTO spanish_campaign_repair_targets VALUES
  ('argentina', 'argentina', 'medium', 5),
  ('barcelona', 'barcelona', 'medium', 9),
  ('la-liga', 'la-liga', 'medium', 6);

CREATE TEMP TABLE spanish_campaign_replacement_seed ON COMMIT DROP AS
WITH eligible AS (
  SELECT
    target.quiz_slug,
    target.display_order,
    question.id AS source_id,
    question.category_id,
    question.type,
    question.difficulty,
    question.prompt,
    question.explanation,
    payload.payload,
    ROW_NUMBER() OVER (
      PARTITION BY target.quiz_slug
      ORDER BY md5(lower(question.prompt->>'en') || question.id::text), question.id
    ) AS candidate_rank
  FROM spanish_campaign_repair_targets target
  JOIN public.categories category ON category.slug = target.category_slug
  JOIN public.questions question
    ON question.category_id = category.id
   AND question.difficulty = target.difficulty
  JOIN public.question_payloads payload ON payload.question_id = question.id
  WHERE question.status = 'published'
    AND question.type = 'mcq_single'
    AND question.ranked_eligible = TRUE
    AND COALESCE(question.prompt->>'en', '') <> ''
    AND COALESCE(question.prompt->>'es', '') <> ''
    AND lower(question.prompt->>'en')
      !~ '(current|currently|this season|2025|2026|pictured|photo|shown behind|this image)'
    AND jsonb_typeof(payload.payload->'options') = 'array'
    AND jsonb_array_length(payload.payload->'options') >= 2
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(payload.payload->'options') option
      WHERE COALESCE(option->'text'->>'en', '') = ''
         OR COALESCE(option->'text'->>'es', '') = ''
    )
    AND (
      SELECT COUNT(*)
      FROM jsonb_array_elements(payload.payload->'options') option
      WHERE COALESCE((option->>'is_correct')::boolean, FALSE)
    ) = 1
    AND NOT EXISTS (
      SELECT 1
      FROM public.campaign_quiz_questions assigned
      JOIN public.questions used ON used.id = assigned.question_id
      WHERE assigned.quiz_slug = target.quiz_slug
        AND used.prompt->>'en' = question.prompt->>'en'
    )
), selected AS (
  SELECT *, md5(
    'quizball-spanish-market-repair-v1:' || quiz_slug || ':' || source_id::text
  ) AS stable_hash
  FROM eligible
  WHERE candidate_rank = 1
)
SELECT
  quiz_slug,
  display_order,
  (
    substr(stable_hash, 1, 8) || '-' ||
    substr(stable_hash, 9, 4) || '-' ||
    substr(stable_hash, 13, 4) || '-' ||
    substr(stable_hash, 17, 4) || '-' ||
    substr(stable_hash, 21, 12)
  )::uuid AS id,
  category_id,
  type,
  difficulty,
  jsonb_strip_nulls(jsonb_build_object(
    'en', prompt->>'en',
    'es', prompt->>'es'
  )) AS prompt,
  CASE
    WHEN COALESCE(explanation->>'en', '') = ''
      AND COALESCE(explanation->>'es', '') = '' THEN NULL
    ELSE jsonb_strip_nulls(jsonb_build_object(
      'en', NULLIF(explanation->>'en', ''),
      'es', NULLIF(explanation->>'es', '')
    ))
  END AS explanation,
  payload
FROM selected;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM spanish_campaign_replacement_seed) <> 3 THEN
    RAISE EXCEPTION 'Spanish campaign question repair did not find three replacements';
  END IF;
END $$;

CREATE TEMP TABLE spanish_campaign_removed_questions ON COMMIT DROP AS
SELECT assigned.question_id
FROM public.campaign_quiz_questions assigned
JOIN spanish_campaign_repair_targets target
  ON target.quiz_slug = assigned.quiz_slug
 AND target.display_order = assigned.display_order;

DELETE FROM public.campaign_quiz_questions assigned
USING spanish_campaign_repair_targets target
WHERE assigned.quiz_slug = target.quiz_slug
  AND assigned.display_order = target.display_order;

-- Do not delete historical question rows: the match_questions foreign key can
-- require a large validation scan. Archiving is immediate, reversible and
-- keeps these rejected prompts out of every public question path.
UPDATE public.questions question
SET status = 'archived',
    visibility = 'wl_private',
    updated_at = NOW()
FROM spanish_campaign_removed_questions removed
WHERE question.id = removed.question_id;

INSERT INTO public.questions (
  id,
  category_id,
  type,
  difficulty,
  status,
  prompt,
  explanation,
  ranked_eligible,
  visibility
)
SELECT
  id,
  category_id,
  type,
  difficulty,
  'published',
  prompt,
  explanation,
  FALSE,
  'public'
FROM spanish_campaign_replacement_seed;

INSERT INTO public.question_payloads (question_id, payload)
SELECT id, payload
FROM spanish_campaign_replacement_seed;

INSERT INTO public.campaign_quiz_questions (
  quiz_slug,
  question_id,
  difficulty,
  display_order
)
SELECT quiz_slug, id, difficulty, display_order
FROM spanish_campaign_replacement_seed;

INSERT INTO public.campaign_quiz_manual_questions (question_id, quiz_slug)
SELECT id, quiz_slug
FROM spanish_campaign_replacement_seed;

DO $$
DECLARE
  incomplete TEXT;
BEGIN
  SELECT string_agg(target.quiz_slug, ', ' ORDER BY target.quiz_slug)
  INTO incomplete
  FROM spanish_campaign_repair_targets target
  WHERE (
    SELECT COUNT(*)
    FROM public.campaign_quiz_questions assigned
    JOIN public.questions question ON question.id = assigned.question_id
    JOIN public.question_payloads payload ON payload.question_id = question.id
    WHERE assigned.quiz_slug = target.quiz_slug
      AND question.status = 'published'
      AND question.visibility = 'public'
      AND question.ranked_eligible = FALSE
      AND COALESCE(question.prompt->>'es', '') <> ''
      AND jsonb_typeof(payload.payload->'options') = 'array'
  ) <> 10;

  IF incomplete IS NOT NULL THEN
    RAISE EXCEPTION 'Spanish campaign question repair left incomplete pages: %', incomplete;
  END IF;
END $$;

COMMIT;
