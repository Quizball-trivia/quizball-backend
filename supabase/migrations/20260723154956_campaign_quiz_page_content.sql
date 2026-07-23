-- Reserve campaign pools from QuizBall's existing published question bank.
--
-- No question copy from the SEO documents is inserted here. Each campaign
-- receives 15 existing selectable questions: five easy, five medium, and five
-- hard. Reserved rows are then excluded from normal and ranked matches.

INSERT INTO public.campaign_quizzes (slug, title, status)
VALUES
  ('liverpool', 'Liverpool Quiz — Test Your LFC Knowledge', 'draft'),
  ('manchester-united', 'Man United Quiz — Test Your Red Devils Knowledge', 'draft'),
  ('tottenham', 'Tottenham Quiz — Test Your Spurs Knowledge', 'draft'),
  ('everton', 'Everton Quiz — Test Your Toffees Knowledge', 'draft'),
  ('premier-league', 'Premier League Football Quiz', 'draft'),
  ('guess-the-player', 'Guess the Player — Football Guess Who', 'draft'),
  ('career-path', 'Football Career Path Quiz', 'draft'),
  ('club-badges', 'Football Club Badges Quiz — Guess the Logo', 'draft')
ON CONFLICT (slug) DO UPDATE
SET title = EXCLUDED.title,
    status = 'draft',
    updated_at = NOW();

-- This also makes the migration safe to rerun during local development.
UPDATE public.questions q
SET ranked_eligible = TRUE,
    updated_at = NOW()
WHERE EXISTS (
  SELECT 1
  FROM public.campaign_quiz_questions cqq
  WHERE cqq.question_id = q.id
);

DELETE FROM public.campaign_quiz_questions;

CREATE TEMP TABLE campaign_quiz_sources (
  quiz_slug TEXT PRIMARY KEY,
  priority SMALLINT NOT NULL
);

INSERT INTO campaign_quiz_sources (quiz_slug, priority)
VALUES
  ('liverpool', 1),
  ('manchester-united', 2),
  ('tottenham', 3),
  ('everton', 4),
  ('club-badges', 5),
  ('career-path', 6),
  ('guess-the-player', 7),
  ('premier-league', 8);

CREATE TEMP TABLE campaign_question_candidates AS
WITH raw_candidates AS (
  SELECT
    source.quiz_slug,
    source.priority,
    q.id AS question_id,
    q.difficulty AS source_difficulty
  FROM campaign_quiz_sources source
  CROSS JOIN public.questions q
  JOIN public.categories category
    ON category.id = q.category_id
  JOIN public.question_payloads payload
    ON payload.question_id = q.id
  WHERE q.status = 'published'
    AND q.ranked_eligible = TRUE
    AND q.id::text NOT LIKE '6c6b8d10-8b8e-4d12-9a%'
    AND COALESCE(q.prompt->>'en', '') <> ''
    AND (
      (
        source.quiz_slug = 'liverpool'
        AND category.slug = 'liverpool'
        AND q.type IN ('mcq_single', 'true_false')
      )
      OR (
        source.quiz_slug = 'manchester-united'
        AND category.slug = 'manchester-united'
        AND q.type IN ('mcq_single', 'true_false')
      )
      OR (
        source.quiz_slug = 'tottenham'
        AND lower(q.prompt->>'en') ~ 'tottenham|spurs|hotspur'
        AND q.type IN ('mcq_single', 'true_false')
      )
      OR (
        source.quiz_slug = 'everton'
        AND lower(q.prompt->>'en') ~ 'everton|toffees|goodison'
        AND q.type IN ('mcq_single', 'true_false')
      )
      OR (
        source.quiz_slug = 'club-badges'
        AND lower(q.prompt->>'en')
          ~ 'badge|crest|logo|emblem|cockerel|liver bird|coat of arms'
        AND q.type IN ('mcq_single', 'true_false')
      )
      OR (
        source.quiz_slug = 'career-path'
        AND category.slug = 'career-path'
        AND q.type = 'career_path'
      )
      OR (
        source.quiz_slug = 'guess-the-player'
        AND q.type = 'clue_chain'
      )
      OR (
        source.quiz_slug = 'premier-league'
        AND category.slug = 'premier-league'
        AND q.type IN ('mcq_single', 'true_false')
      )
    )
),
owned_candidates AS (
  SELECT
    raw_candidates.*,
    ROW_NUMBER() OVER (
      PARTITION BY question_id
      ORDER BY priority ASC, quiz_slug ASC
    ) AS owner_rank
  FROM raw_candidates
)
SELECT quiz_slug, question_id, source_difficulty
FROM owned_candidates
WHERE owner_rank = 1;

-- Prefer each question's bank difficulty. If a narrowly themed pool does not
-- contain five at a given level, use the closest remaining questions and
-- classify them specifically for this campaign.
WITH ranked AS (
  SELECT
    candidate.quiz_slug,
    candidate.question_id,
    ROW_NUMBER() OVER (
      PARTITION BY candidate.quiz_slug
      ORDER BY
        CASE candidate.source_difficulty
          WHEN 'easy' THEN 0
          WHEN 'medium' THEN 1
          ELSE 2
        END,
        md5(candidate.question_id::text || candidate.quiz_slug)
    ) AS candidate_rank
  FROM campaign_question_candidates candidate
)
INSERT INTO public.campaign_quiz_questions (
  quiz_slug,
  question_id,
  difficulty,
  display_order
)
SELECT quiz_slug, question_id, 'easy', candidate_rank
FROM ranked
WHERE candidate_rank <= 5;

WITH remaining AS (
  SELECT candidate.*
  FROM campaign_question_candidates candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.campaign_quiz_questions assigned
    WHERE assigned.question_id = candidate.question_id
  )
),
ranked AS (
  SELECT
    remaining.quiz_slug,
    remaining.question_id,
    ROW_NUMBER() OVER (
      PARTITION BY remaining.quiz_slug
      ORDER BY
        CASE remaining.source_difficulty
          WHEN 'medium' THEN 0
          WHEN 'hard' THEN 1
          ELSE 2
        END,
        md5(remaining.question_id::text || remaining.quiz_slug)
    ) AS candidate_rank
  FROM remaining
)
INSERT INTO public.campaign_quiz_questions (
  quiz_slug,
  question_id,
  difficulty,
  display_order
)
SELECT quiz_slug, question_id, 'medium', 5 + candidate_rank
FROM ranked
WHERE candidate_rank <= 5;

WITH remaining AS (
  SELECT candidate.*
  FROM campaign_question_candidates candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.campaign_quiz_questions assigned
    WHERE assigned.question_id = candidate.question_id
  )
),
ranked AS (
  SELECT
    remaining.quiz_slug,
    remaining.question_id,
    ROW_NUMBER() OVER (
      PARTITION BY remaining.quiz_slug
      ORDER BY
        CASE remaining.source_difficulty
          WHEN 'hard' THEN 0
          WHEN 'medium' THEN 1
          ELSE 2
        END,
        md5(remaining.question_id::text || remaining.quiz_slug)
    ) AS candidate_rank
  FROM remaining
)
INSERT INTO public.campaign_quiz_questions (
  quiz_slug,
  question_id,
  difficulty,
  display_order
)
SELECT quiz_slug, question_id, 'hard', 10 + candidate_rank
FROM ranked
WHERE candidate_rank <= 5;

UPDATE public.questions q
SET ranked_eligible = FALSE,
    updated_at = NOW()
WHERE EXISTS (
  SELECT 1
  FROM public.campaign_quiz_questions cqq
  WHERE cqq.question_id = q.id
);

UPDATE public.campaign_quizzes quiz
SET status = CASE
      WHEN pool.total = 15
        AND pool.easy = 5
        AND pool.medium = 5
        AND pool.hard = 5
      THEN 'published'
      ELSE 'draft'
    END,
    updated_at = NOW()
FROM (
  SELECT
    configured.quiz_slug,
    COUNT(assigned.question_id)::int AS total,
    COUNT(*) FILTER (WHERE assigned.difficulty = 'easy')::int AS easy,
    COUNT(*) FILTER (WHERE assigned.difficulty = 'medium')::int AS medium,
    COUNT(*) FILTER (WHERE assigned.difficulty = 'hard')::int AS hard
  FROM campaign_quiz_sources configured
  LEFT JOIN public.campaign_quiz_questions assigned
    ON assigned.quiz_slug = configured.quiz_slug
  GROUP BY configured.quiz_slug
) pool
WHERE quiz.slug = pool.quiz_slug;
