-- Show the club crest on the club-badges campaign questions that name a club.
--
-- "FC Koln have which animal on their club crest?" is hard to picture from text
-- alone. Attaching the crest turns it into something you can actually look at.
--
-- This is deliberately NOT applied to every question in the quiz. Where the
-- answer *is* the club ("Which Serie A team's logo features a bull?" -> Torino)
-- the crest would give the answer away, and the sponsor questions (Audi on the
-- Bayern sleeve, UNICEF on the Barcelona shirt) are not answerable from a crest
-- at all. Only questions that name a club and ask what appears on its badge get
-- an image.

CREATE TEMP TABLE club_badge_question_images (
  question_id UUID PRIMARY KEY,
  badge_slug TEXT NOT NULL
);

INSERT INTO club_badge_question_images (question_id, badge_slug)
VALUES
  -- "FC Koln have which animal on their club crest?" -> Goat
  ('c5d37e34-21c3-416e-a8de-6d0ef604c237', '1-fc-koln'),
  -- "Which animal is famously featured on the Chelsea's badge?" -> A Lion
  ('2a3f8fb8-1d33-4be1-b434-8d250be3bfbf', 'chelsea-fc'),
  -- "What symbol of Yorkshire is featured on the Leeds United club badge?" -> The White Rose
  ('6e6c6985-879e-464f-9e6b-70d86b1636ef', 'leeds-united'),
  -- "The current Chelsea crest features a lion holding what object?" -> An abbot's staff
  ('36dd5f4a-9660-4d66-af10-ab493d66b6b7', 'chelsea-fc'),
  -- "What symbol is featured prominently on the Arsenal club crest?" -> A Cannon
  ('fc2872fd-7d5b-489b-9983-ef1259638f69', 'arsenal-fc');

-- Derive the storage origin from an image this project already serves rather
-- than hardcoding a project ref, so this runs correctly on staging and prod.
CREATE TEMP TABLE club_badge_base AS
SELECT regexp_replace(
         payload->'image'->>'url',
         '/storage/v1/object/public/imgs/.*$',
         '/storage/v1/object/public/imgs/club-badges/'
       ) AS base_url
FROM public.question_payloads
WHERE payload->'image'->>'url' LIKE '%/storage/v1/object/public/imgs/%'
LIMIT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM club_badge_base) THEN
    RAISE EXCEPTION 'Could not derive Supabase storage base URL for club badges';
  END IF;
END;
$$;

-- Only touch questions still reserved by this campaign, so a re-curation that
-- swapped a question out cannot leave a crest attached to an unrelated one.
UPDATE public.question_payloads qp
SET payload = jsonb_set(
      qp.payload,
      '{image}',
      jsonb_build_object(
        'url', (SELECT base_url FROM club_badge_base) || mapping.badge_slug || '.webp',
        'width', 139,
        'height', 181,
        'aspect_ratio', '139:181',
        'provider', 'quizball-club-badges',
        'storage_status', 'stored'
      ),
      true
    )
FROM club_badge_question_images mapping
JOIN public.campaign_quiz_questions cqq
  ON cqq.question_id = mapping.question_id
 AND cqq.quiz_slug = 'club-badges'
WHERE qp.question_id = mapping.question_id
  AND qp.payload->>'type' = 'mcq_single';
