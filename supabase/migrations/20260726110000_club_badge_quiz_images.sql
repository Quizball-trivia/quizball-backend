-- Replace the full club crests on the badge quiz with answer-masked versions.
--
-- 20260725160000 attached whole crests to five questions. That made the five
-- easier to look at but gave the answer away: the crest for "FC Koln have
-- which animal on their crest?" shows the goat, and the crest for "which club
-- has a Biscione?" identifies the club outright.
--
-- These images hide the answer instead. Which part is hidden depends on what
-- the question asks:
--   * answer is the SYMBOL  -> blur the symbol, keep the club name readable
--   * answer is the CLUB    -> blur the wordmark, keep the symbol readable
--
-- Source art comes from the crests the site already ships in public/clubs,
-- rendered at 1280px from the freely licensed Wikimedia vectors where one
-- exists. Resolution matters: at the 139px thumbnails a blur strong enough to
-- destroy lettering also destroys the artwork around it.

-- Clear every image on this quiz first, so the five full crests from the
-- previous migration cannot survive alongside the masked set.
UPDATE public.question_payloads qp
SET payload = qp.payload - 'image'
FROM public.campaign_quiz_questions cqq
WHERE cqq.question_id = qp.question_id
  AND cqq.quiz_slug = 'club-badges';

CREATE TEMP TABLE club_badge_quiz_images (
  question_id UUID PRIMARY KEY,
  asset TEXT NOT NULL,
  width INT NOT NULL,
  height INT NOT NULL
);

INSERT INTO club_badge_quiz_images (question_id, asset, width, height)
VALUES
  -- Answer is the club: wordmark hidden, symbol visible.
  ('75f3c41b-962a-4df6-a2c9-709251b7215a', 'q01', 600, 395),  -- RB Leipzig, bulls
  ('44f8e84a-9a91-485e-bb43-c307f354a883', 'q05', 346, 600),  -- Monaco, chequer + crown
  ('69a371b3-0fa6-4ac4-84c6-75b39de97872', 'q12', 486, 600),  -- Nice, eagle
  ('7d74b6a8-c425-4c2f-aa53-bcfed5f7e571', 'q13', 139, 181),  -- Genoa, griffin (no text on crest)
  ('f128a788-260a-473e-a5b5-85383ccd1be1', 'q15', 139, 181),  -- Torino, bull

  -- Answer is the symbol: symbol hidden, club still identifiable.
  ('c5d37e34-21c3-416e-a8de-6d0ef604c237', 'q02', 589, 600),  -- Koln, goat hidden
  ('2a3f8fb8-1d33-4be1-b434-8d250be3bfbf', 'q03', 139, 181),  -- Chelsea, lion hidden
  ('6e6c6985-879e-464f-9e6b-70d86b1636ef', 'q04', 482, 600),  -- Leeds, rose hidden
  ('fc2872fd-7d5b-489b-9983-ef1259638f69', 'q14', 139, 181);  -- Arsenal, cannon hidden

-- Questions 6 (Inter), 7 (Udinese), 8 (Man City), 9 (Chelsea staff), 10 (Bayern
-- sleeve sponsor) and 11 (Barcelona shirt sponsor) get no image. Inter's crest
-- is an "IM" monogram with no Biscione and Udinese's is an abstract mark with
-- no zebra, in every era; the sponsors are not crest elements at all; and the
-- abbot's staff cannot be masked without destroying the lion holding it.

-- Derive the storage origin from an image this project already serves rather
-- than hardcoding a project ref, so this runs on staging and prod alike.
CREATE TEMP TABLE club_badge_quiz_base AS
SELECT regexp_replace(
         payload->'image'->>'url',
         '/storage/v1/object/public/imgs/.*$',
         '/storage/v1/object/public/imgs/club-badge-quiz/'
       ) AS base_url
FROM public.question_payloads
WHERE payload->'image'->>'url' LIKE '%/storage/v1/object/public/imgs/%'
LIMIT 1;

UPDATE public.question_payloads qp
SET payload = jsonb_set(
      qp.payload,
      '{image}',
      jsonb_build_object(
        'url', (SELECT base_url FROM club_badge_quiz_base) || img.asset || '.png',
        'width', img.width,
        'height', img.height,
        'provider', 'quizball-club-badge-quiz',
        'storage_status', 'stored'
      ),
      true
    )
FROM club_badge_quiz_images img
JOIN public.campaign_quiz_questions cqq
  ON cqq.question_id = img.question_id
 AND cqq.quiz_slug = 'club-badges'
WHERE qp.question_id = img.question_id
  AND qp.payload->>'type' = 'mcq_single'
  AND EXISTS (SELECT 1 FROM club_badge_quiz_base);
