-- Pin the prod campaign pools to the exact selection reviewed on staging.
--
-- 20260723154956 and 20260725120000 pick questions by querying the local bank,
-- so a different bank produces a different quiz. Prod holds ~15.8k published
-- questions against staging's smaller set, and re-running the selection there
-- produced a different 120 -- which also meant the badge images, keyed by
-- question id, no longer matched their questions.
--
-- These are the 120 questions signed off on staging. Every one already exists
-- in prod with the same id, so this pins the result rather than re-deriving it.

-- Three of them were archived in prod while still live on staging. They are
-- part of the reviewed set, so restore them to published; the campaign reader
-- filters on status and would otherwise leave those quizzes short.
UPDATE public.questions
SET status = 'published',
    updated_at = NOW()
WHERE status = 'archived'
  AND id IN (
  '38aa208b-330d-4cfb-8787-3de1856a8ff4',
  '4ccf44ba-d1da-4fc6-83de-e29f96694730',
  '9fccc4c4-d266-4662-8061-99dda744e1fe'
  );

-- Release the questions the auto-selection reserved so anything not in the
-- reviewed set returns to ranked play.
UPDATE public.questions q
SET ranked_eligible = TRUE,
    updated_at = NOW()
WHERE EXISTS (
  SELECT 1 FROM public.campaign_quiz_questions cqq WHERE cqq.question_id = q.id
);

DELETE FROM public.campaign_quiz_questions;

INSERT INTO public.campaign_quiz_questions (quiz_slug, question_id, difficulty, display_order)
VALUES
  ('career-path', 'e217d839-b69f-4b19-b7f1-287771a17973', 'easy', 1),
  ('career-path', '07b6c109-97af-4a93-81fb-0eacab91927e', 'easy', 2),
  ('career-path', 'e0c40003-8e6d-48f0-8612-b04c98238dbf', 'easy', 3),
  ('career-path', '5ff969c4-e189-4c19-95c3-e7b9f38d1c4e', 'easy', 4),
  ('career-path', '33844d6f-301a-4b3e-a089-5a33965e79fb', 'easy', 5),
  ('career-path', '38aa208b-330d-4cfb-8787-3de1856a8ff4', 'medium', 6),
  ('career-path', '4ccf44ba-d1da-4fc6-83de-e29f96694730', 'medium', 7),
  ('career-path', 'fdcf80ec-d457-4dc3-8243-6aa39284575d', 'medium', 8),
  ('career-path', '53b9290f-5eca-4266-9eb3-bd5e7fbcbc55', 'medium', 9),
  ('career-path', '7c8c03d2-9df6-4aa1-8c2c-7318def52c39', 'medium', 10),
  ('career-path', 'ab152fdc-5280-47f1-96af-677b0081ddae', 'hard', 11),
  ('career-path', '115b3e52-c450-4bde-a8b9-2a74770dbb86', 'hard', 12),
  ('career-path', '58217d61-4714-47d0-b5fe-f2d88cf03359', 'hard', 13),
  ('career-path', 'f9745d5a-df51-4bc4-8894-ec2721354515', 'hard', 14),
  ('career-path', 'ac62abea-36a8-4628-9880-731a4861edd6', 'hard', 15),
  ('club-badges', '75f3c41b-962a-4df6-a2c9-709251b7215a', 'easy', 1),
  ('club-badges', 'c5d37e34-21c3-416e-a8de-6d0ef604c237', 'easy', 2),
  ('club-badges', '2a3f8fb8-1d33-4be1-b434-8d250be3bfbf', 'easy', 3),
  ('club-badges', '6e6c6985-879e-464f-9e6b-70d86b1636ef', 'easy', 4),
  ('club-badges', '44f8e84a-9a91-485e-bb43-c307f354a883', 'easy', 5),
  ('club-badges', '4e34873c-6e37-40b5-b2d1-7a969b5865d0', 'medium', 6),
  ('club-badges', '51086b00-393a-40b1-9ee4-52eb310b7de8', 'medium', 7),
  ('club-badges', '633143d1-3435-49dd-85af-cf52b3e53218', 'medium', 8),
  ('club-badges', '36dd5f4a-9660-4d66-af10-ab493d66b6b7', 'medium', 9),
  ('club-badges', '71a03e65-e615-4b57-8d8b-d106161a709b', 'medium', 10),
  ('club-badges', '63786d0c-3382-484e-8c23-10456a594fb2', 'hard', 11),
  ('club-badges', '69a371b3-0fa6-4ac4-84c6-75b39de97872', 'hard', 12),
  ('club-badges', '7d74b6a8-c425-4c2f-aa53-bcfed5f7e571', 'hard', 13),
  ('club-badges', 'fc2872fd-7d5b-489b-9983-ef1259638f69', 'hard', 14),
  ('club-badges', 'f128a788-260a-473e-a5b5-85383ccd1be1', 'hard', 15),
  ('everton', '4a737d7f-5e82-4a0a-afb4-9e163d9754bb', 'easy', 1),
  ('everton', '78e981e6-2263-4522-bd76-9819879ac6f4', 'easy', 2),
  ('everton', 'aa480014-ff29-469c-86d7-a61fc037b743', 'easy', 3),
  ('everton', '4c4969e0-50c8-4be7-b272-6b50379da05c', 'easy', 4),
  ('everton', '6e54dc17-7770-4d76-861f-93924a5565f6', 'easy', 5),
  ('everton', 'ac0080a7-718c-4bb4-958a-584ce3b34099', 'medium', 6),
  ('everton', '941dd942-a104-4999-b42f-77c463c73319', 'medium', 7),
  ('everton', 'cd3cc64e-da98-430c-93a1-b669ce0d17e5', 'medium', 8),
  ('everton', '880a0204-f7e7-4e04-b1fd-437af1b75571', 'medium', 9),
  ('everton', 'a7511e3f-1102-4cec-bbe2-fcdb35ae7a8a', 'medium', 10),
  ('everton', '86a65e36-47a5-4016-96dc-9766ae6f606a', 'hard', 11),
  ('everton', 'e5d9af53-b01d-4ede-a184-b7b0c3845f22', 'hard', 12),
  ('everton', 'b679f535-9feb-422d-8c11-47fa7c474880', 'hard', 13),
  ('everton', '264b154b-be86-4090-8fed-26c08e829cb3', 'hard', 14),
  ('everton', '11daf3e7-a7b3-4e9b-a183-b440e4953065', 'hard', 15),
  ('guess-the-player', '610f363e-9024-4cce-b8f2-bc9817eba83e', 'easy', 1),
  ('guess-the-player', '49c1b852-1f90-43bf-9dfa-28f4a2ac5787', 'easy', 2),
  ('guess-the-player', 'ea34cfa0-e4d4-494b-a397-5245ff5e3782', 'easy', 3),
  ('guess-the-player', 'c5b93eb3-b2dd-4dec-8f53-d7e479f0ed96', 'easy', 4),
  ('guess-the-player', '490a2639-007e-40ff-8bf0-ab270f955bba', 'easy', 5),
  ('guess-the-player', 'b216fcf8-2c65-4613-b8c2-da00df7c7f1b', 'medium', 6),
  ('guess-the-player', '7210f36b-d676-44cf-abe4-be2ab2abd516', 'medium', 7),
  ('guess-the-player', '7921fc89-cd0c-45bf-8376-f8d23f951b8f', 'medium', 8),
  ('guess-the-player', '3c3ce7f0-c928-4b57-85ad-2a6f2a7dde50', 'medium', 9),
  ('guess-the-player', '9fccc4c4-d266-4662-8061-99dda744e1fe', 'medium', 10),
  ('guess-the-player', '786de1d0-6f1b-4fe7-aee2-9de27ffbaa97', 'hard', 11),
  ('guess-the-player', 'ebc39821-c784-4ac1-996c-5105b32dfd61', 'hard', 12),
  ('guess-the-player', '6653697b-1304-4f47-a06c-f426d9ca7db1', 'hard', 13),
  ('guess-the-player', '5b9b6775-e8f3-48a0-b3ed-5e93a62769e5', 'hard', 14),
  ('guess-the-player', '7746841a-700c-4bed-add9-83ab7b28eccc', 'hard', 15),
  ('liverpool', '9ac66dde-0338-455a-bfea-6368852f01d7', 'easy', 1),
  ('liverpool', '12245c39-ee95-4823-ad3e-e2b9b174808a', 'easy', 2),
  ('liverpool', '1363d307-2b0b-402d-8e58-65cc7e66a9b7', 'easy', 3),
  ('liverpool', '3a3e3b5d-678c-46c3-b1a1-8730f763b406', 'easy', 4),
  ('liverpool', '3f92509f-4949-428d-bf8c-89d45b7baf7e', 'easy', 5),
  ('liverpool', 'ed16ba5b-4a62-4397-8ba8-c5966dc1d7f0', 'medium', 6),
  ('liverpool', 'd93a89a5-f728-4efc-91cb-d0f3fd6b30d9', 'medium', 7),
  ('liverpool', '5bce9750-0924-43b5-8e7e-c5def73d550a', 'medium', 8),
  ('liverpool', '72c47cc5-ef1f-4b1f-8b6b-1c2cf2159be9', 'medium', 9),
  ('liverpool', '8a8776f2-d921-4e07-b716-c75ff45bf5f8', 'medium', 10),
  ('liverpool', '4cf2e933-b472-4847-9c3c-1b3a289854c7', 'hard', 11),
  ('liverpool', 'f31e6952-334a-4a76-8829-d591a56c6440', 'hard', 12),
  ('liverpool', '6dde5779-f3fe-4c43-b529-c27e29df3a12', 'hard', 13),
  ('liverpool', '364c4979-6646-405a-8dc4-80288408d27f', 'hard', 14),
  ('liverpool', '62de4e1b-6778-4ce3-95b8-959507da1fa2', 'hard', 15),
  ('manchester-united', '90a79094-3866-4096-8189-27708f2d8bb5', 'easy', 1),
  ('manchester-united', 'edc7f6e4-5e35-41d8-b0da-c08d3ab2b138', 'easy', 2),
  ('manchester-united', '942fff84-6047-411e-8ee8-47fed46a5fff', 'easy', 3),
  ('manchester-united', '53b1db02-c6a7-427d-8571-7d8270c3e5ff', 'easy', 4),
  ('manchester-united', '57189cd1-98f5-4d6b-aca2-d6d37cd705c5', 'easy', 5),
  ('manchester-united', 'f60086cc-d6f4-47c1-b112-d4415ee8c702', 'medium', 6),
  ('manchester-united', '88e7d23d-3572-4c48-87b6-c044366a9352', 'medium', 7),
  ('manchester-united', 'd468a8a9-8eca-4751-959b-f9c98aa810e5', 'medium', 8),
  ('manchester-united', '040cd1f9-43b6-49f0-80a1-3c945588d13c', 'medium', 9),
  ('manchester-united', '2f5b7906-993b-4910-b9ac-84115c068cd5', 'medium', 10),
  ('manchester-united', '0173dad1-42ed-4f4f-917b-838b231200a5', 'hard', 11),
  ('manchester-united', 'ceb54e8e-d807-4343-ba3a-96e59cc1440d', 'hard', 12),
  ('manchester-united', '75d06fc2-b3e7-4544-82c2-df9dd50a9ee3', 'hard', 13),
  ('manchester-united', '3e379563-4961-46ae-9159-2b12455d50dd', 'hard', 14),
  ('manchester-united', '513d56d9-7f0e-40fc-9538-dcfa42195ee3', 'hard', 15),
  ('premier-league', '8f43aa13-da31-4d37-959b-ce6708c5024f', 'easy', 1),
  ('premier-league', 'd3a801da-4c7a-4528-a07c-4d31689b28e7', 'easy', 2),
  ('premier-league', '966c774d-55d7-4884-aef1-d9e7a5662918', 'easy', 3),
  ('premier-league', 'e8dc920c-d910-4a2f-9514-e30653e388b1', 'easy', 4),
  ('premier-league', 'dde34767-052c-4757-9452-87cd9e5ec280', 'easy', 5),
  ('premier-league', 'bbec7245-1299-48f9-8830-7e1d8560c60b', 'medium', 6),
  ('premier-league', '358f7500-6ab5-4f8e-8934-d15ac8aa54c2', 'medium', 7),
  ('premier-league', 'd99b40e4-add7-4118-befb-957acced6e29', 'medium', 8),
  ('premier-league', '1b7def94-5c64-46b8-983b-45d77cdd5d2f', 'medium', 9),
  ('premier-league', 'ea97be4c-ae8b-4e59-9ebf-b94db2bf5dd0', 'medium', 10),
  ('premier-league', 'fa4c38d7-2c33-4e70-98d3-fd21d57afca9', 'hard', 11),
  ('premier-league', '9cff12a0-05e8-482b-b3d4-221cee88aff9', 'hard', 12),
  ('premier-league', 'b5018bdb-d0f7-4501-9a39-f097b8c33f5e', 'hard', 13),
  ('premier-league', '9e3e1179-be86-47e3-a504-9416fa47a3cb', 'hard', 14),
  ('premier-league', '3fc628c7-8183-48f4-9da1-303fe209bfb1', 'hard', 15),
  ('tottenham', '00db0513-25dc-4dc4-ab25-e9d43120d65a', 'easy', 1),
  ('tottenham', '69f68987-c97d-433a-acd0-75ee0a31176a', 'easy', 2),
  ('tottenham', 'ce661aed-600e-414e-b1ea-476b707a20df', 'easy', 3),
  ('tottenham', '14752fc8-4713-4fba-9cb8-e7aa2b50bee7', 'easy', 4),
  ('tottenham', '4e6ffde4-52fd-4bb1-bbc3-4b4a24b4d078', 'easy', 5),
  ('tottenham', 'af21b26b-ae31-415a-8a8b-bbbeca540942', 'medium', 6),
  ('tottenham', 'e7e6c606-cb5f-4d8d-b2d8-f40607860bd8', 'medium', 7),
  ('tottenham', '6b4687c1-8ff6-4469-b515-b6b70e56c433', 'medium', 8),
  ('tottenham', 'b23cffd6-0c76-4cc6-b037-45c73671c2b6', 'medium', 9),
  ('tottenham', '75d14851-129f-4f3b-b28f-7b752e94cb4a', 'medium', 10),
  ('tottenham', 'ad57d0c0-859b-4b5e-a88d-834cf5b5c90b', 'hard', 11),
  ('tottenham', '36630efa-5809-4535-a173-0eb5ea61e670', 'hard', 12),
  ('tottenham', 'a2242d1a-91be-4caf-83a7-cc57af0181fe', 'hard', 13),
  ('tottenham', 'eed47868-42b3-44c9-9d34-d434994d9f5c', 'hard', 14),
  ('tottenham', 'c529519b-03c4-4875-90e7-028db51653ba', 'hard', 15)
ON CONFLICT (quiz_slug, question_id) DO UPDATE
SET difficulty = EXCLUDED.difficulty,
    display_order = EXCLUDED.display_order;

UPDATE public.questions q
SET ranked_eligible = FALSE,
    updated_at = NOW()
WHERE EXISTS (
  SELECT 1 FROM public.campaign_quiz_questions cqq WHERE cqq.question_id = q.id
);

-- Publish only a complete 5/5/5 pool, so an incomplete campaign 404s rather
-- than shipping a half-empty quiz to search.
UPDATE public.campaign_quizzes quiz
SET status = CASE
      WHEN pool.total = 15 AND pool.easy = 5 AND pool.medium = 5 AND pool.hard = 5
      THEN 'published' ELSE 'draft' END,
    updated_at = NOW()
FROM (
  SELECT cq.slug AS quiz_slug,
         COUNT(a.question_id)::int AS total,
         COUNT(*) FILTER (WHERE a.difficulty = 'easy')::int AS easy,
         COUNT(*) FILTER (WHERE a.difficulty = 'medium')::int AS medium,
         COUNT(*) FILTER (WHERE a.difficulty = 'hard')::int AS hard
  FROM public.campaign_quizzes cq
  LEFT JOIN public.campaign_quiz_questions a ON a.quiz_slug = cq.slug
  GROUP BY cq.slug
) pool
WHERE quiz.slug = pool.quiz_slug;

-- The badge-quiz images were attached by 20260726110000 against the previous
-- selection, and the DELETE above dropped those assignments. Re-apply them now
-- that the reviewed questions are back in place.
UPDATE public.question_payloads qp
SET payload = qp.payload - 'image'
FROM public.campaign_quiz_questions cqq
WHERE cqq.question_id = qp.question_id
  AND cqq.quiz_slug = 'club-badges';

CREATE TEMP TABLE pinned_badge_images (
  question_id UUID PRIMARY KEY,
  asset TEXT NOT NULL,
  width INT NOT NULL,
  height INT NOT NULL
);

INSERT INTO pinned_badge_images (question_id, asset, width, height)
VALUES
  ('75f3c41b-962a-4df6-a2c9-709251b7215a', 'q01', 600, 395),
  ('44f8e84a-9a91-485e-bb43-c307f354a883', 'q05', 346, 600),
  ('69a371b3-0fa6-4ac4-84c6-75b39de97872', 'q12', 486, 600),
  ('7d74b6a8-c425-4c2f-aa53-bcfed5f7e571', 'q13', 139, 181),
  ('f128a788-260a-473e-a5b5-85383ccd1be1', 'q15', 139, 181),
  ('c5d37e34-21c3-416e-a8de-6d0ef604c237', 'q02', 589, 600),
  ('2a3f8fb8-1d33-4be1-b434-8d250be3bfbf', 'q03', 139, 181),
  ('6e6c6985-879e-464f-9e6b-70d86b1636ef', 'q04', 482, 600),
  ('fc2872fd-7d5b-489b-9983-ef1259638f69', 'q14', 139, 181);

CREATE TEMP TABLE pinned_badge_base AS
SELECT regexp_replace(
         payload->'image'->>'url',
         '/storage/v1/object/public/imgs/.*$',
         '/storage/v1/object/public/imgs/club-badge-quiz/'
       ) AS base_url
FROM public.question_payloads
WHERE payload->'image'->>'url' LIKE '%/storage/v1/object/public/imgs/%'
LIMIT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pinned_badge_base) THEN
    RAISE EXCEPTION 'Could not derive Supabase storage base URL for badge quiz images';
  END IF;
END;
$$;

UPDATE public.question_payloads qp
SET payload = jsonb_set(
      qp.payload, '{image}',
      jsonb_build_object(
        'url', (SELECT base_url FROM pinned_badge_base) || img.asset || '.png',
        'width', img.width,
        'height', img.height,
        'provider', 'quizball-club-badge-quiz',
        'storage_status', 'stored'
      ), true)
FROM pinned_badge_images img
JOIN public.campaign_quiz_questions cqq
  ON cqq.question_id = img.question_id AND cqq.quiz_slug = 'club-badges'
WHERE qp.question_id = img.question_id
  AND qp.payload->>'type' = 'mcq_single';

DROP TABLE IF EXISTS pinned_badge_base;
DROP TABLE IF EXISTS pinned_badge_images;
