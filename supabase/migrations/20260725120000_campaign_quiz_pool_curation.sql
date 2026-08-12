-- Re-curate the public SEO campaign pools.
--
-- The original selection (20260723154956) matched questions by regex over
-- prompt text with no category guard. That pulled non-player questions into
-- player quizzes, national-team crests into a club-badge quiz, and duplicate
-- bank rows into the same 15-question set. Because clue_chain and career_path
-- distractors are generated from the *other* answers in the same quiz, a
-- single non-player answer ("Red") also contaminated the options of every
-- other question in that quiz.
--
-- This migration re-selects each pool with explicit category and topic guards,
-- de-duplicates on a normalized prompt, and drops questions unsuitable for a
-- public marketing page.

-- Fold accents before comparing answers. "Kylian Mbappé" and "Kylian Mbappe"
-- are separate bank rows that stripping punctuation alone will not collapse.
CREATE OR REPLACE FUNCTION pg_temp.campaign_fold(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(
    translate(
      lower(COALESCE(value, '')),
      'áàâäãåéèêëíìîïóòôöõøúùûüñçšžýÿ',
      'aaaaaaeeeeiiiioooooouuuuncszyy'
    ),
    '[^a-z0-9]', '', 'g'
  );
$$;

-- Release the current reservations so questions dropped from a campaign return
-- to the ranked pool, and so this migration is safe to rerun.
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

-- Questions that must never appear on a public acquisition page, regardless of
-- which pool they qualify for.
CREATE TEMP TABLE campaign_question_blocklist AS
SELECT q.id AS question_id
FROM public.questions q
WHERE
  -- The Hillsborough disaster killed 97 people. It is legitimate in-app
  -- trivia, but rendering it as a multiple-choice scoreline on a marketing
  -- landing page is not appropriate.
  lower(q.prompt->>'en') ~ 'hillsborough|heysel|munich air|bradford fire'
  -- Categories whose clue_chain answers are colours, stadiums or crests rather
  -- than people. These poison generated distractors in the player quizzes.
  OR (
    q.type IN ('clue_chain', 'career_path')
    AND EXISTS (
      SELECT 1
      FROM public.categories c
      WHERE c.id = q.category_id
        AND c.slug ~ 'crest|kit|stadium|badge|logo|mascot'
    )
  );

CREATE TEMP TABLE campaign_question_candidates AS
WITH raw_candidates AS (
  SELECT
    source.quiz_slug,
    source.priority,
    q.id AS question_id,
    q.difficulty AS source_difficulty,
    qp.payload AS payload,
    pg_temp.campaign_fold(
      COALESCE(qp.payload->'display_answer'->>'en', q.prompt->>'en', '')
    ) AS dedupe_key
  FROM campaign_quiz_sources source
  CROSS JOIN public.questions q
  LEFT JOIN public.categories category
    ON category.id = q.category_id
  JOIN public.question_payloads qp
    ON qp.question_id = q.id
  WHERE q.status = 'published'
    AND q.ranked_eligible = TRUE
    AND q.id::text NOT LIKE '6c6b8d10-8b8e-4d12-9a%'
    AND COALESCE(q.prompt->>'en', '') <> ''
    AND NOT EXISTS (
      SELECT 1 FROM campaign_question_blocklist b WHERE b.question_id = q.id
    )
    -- Reject load-test seeds and placeholder rows. These carry answers like
    -- "Answer" that are meaningless to a player and, because distractors are
    -- generated from sibling answers, would surface across the whole quiz.
    AND lower(COALESCE(qp.payload->'display_answer'->>'en', '')) NOT IN
      ('answer', 'player', 'unknown', 'n/a', 'na', 'tbd', 'test', 'none')
    AND lower(q.prompt->>'en') !~ '^load seed question|^test question|^seed question'
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
        -- Keep the quiz about United rather than about their opponents.
        AND lower(q.prompt->>'en') ~ 'united|old trafford|ferguson|red devils'
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
        -- Club badges only. National-team and World Cup crests belong to a
        -- different quiz and contradict this page's title.
        AND lower(q.prompt->>'en') !~ 'world cup|national team|nation '
        AND q.type IN ('mcq_single', 'true_false')
      )
      OR (
        source.quiz_slug = 'career-path'
        AND category.slug = 'career-path'
        AND q.type = 'career_path'
        -- A career path with fewer than two clubs renders as a bare prompt
        -- with no information to reason from.
        AND jsonb_array_length(COALESCE(qp.payload->'clubs', '[]'::jsonb)) >= 2
      )
      OR (
        source.quiz_slug = 'guess-the-player'
        AND q.type = 'clue_chain'
        -- Only pools whose answer is a person.
        AND COALESCE(category.slug, '') !~ 'crest|kit|stadium|badge|logo|mascot'
      )
      OR (
        source.quiz_slug = 'premier-league'
        AND category.slug = 'premier-league'
        AND q.type IN ('mcq_single', 'true_false')
        -- Exclude questions whose subject is a different competition.
        AND lower(q.prompt->>'en') !~ 'champions league|europa league|world cup'
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
),
-- Collapse near-duplicate bank rows (same answer, differing only in
-- punctuation or accents) so one quiz cannot ask the same thing twice.
deduped_candidates AS (
  SELECT
    owned_candidates.*,
    ROW_NUMBER() OVER (
      PARTITION BY quiz_slug, dedupe_key
      ORDER BY md5(question_id::text || quiz_slug)
    ) AS dedupe_rank
  FROM owned_candidates
  WHERE owner_rank = 1
)
SELECT quiz_slug, question_id, source_difficulty
FROM deduped_candidates
WHERE dedupe_rank = 1;

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

-- Only a complete 5/5/5 pool goes live. An incomplete campaign stays in draft
-- and its page 404s rather than shipping a half-empty quiz to search.
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
