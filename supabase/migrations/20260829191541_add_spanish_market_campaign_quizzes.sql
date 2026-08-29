BEGIN;

-- These are content-only additions. Fail fast instead of waiting behind live
-- gameplay traffic, and keep CMS-owned question changes inside this migration.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
SET LOCAL quizball.campaign_quiz_write = 'on';

CREATE TEMP TABLE spanish_market_quiz_seed (
  slug TEXT PRIMARY KEY,
  page_category TEXT NOT NULL,
  source_category_slug TEXT NOT NULL,
  title_en TEXT NOT NULL,
  title_es TEXT NOT NULL,
  h1_en TEXT NOT NULL,
  h1_es TEXT NOT NULL,
  lede_en TEXT NOT NULL,
  lede_es TEXT NOT NULL,
  about_heading_en TEXT NOT NULL,
  about_heading_es TEXT NOT NULL,
  about_blocks_en JSONB NOT NULL,
  about_blocks_es JSONB NOT NULL,
  seo_title_en TEXT NOT NULL,
  seo_title_es TEXT NOT NULL,
  meta_description_en TEXT NOT NULL,
  meta_description_es TEXT NOT NULL,
  image_alt_en TEXT NOT NULL,
  image_alt_es TEXT NOT NULL,
  score_cta_en TEXT NOT NULL,
  score_cta_es TEXT NOT NULL,
  footer_banner_en TEXT NOT NULL,
  footer_banner_es TEXT NOT NULL,
  hub_order INTEGER NOT NULL
) ON COMMIT DROP;

INSERT INTO spanish_market_quiz_seed VALUES
  (
    'real-madrid', 'team', 'real-madrid',
    'Real Madrid Quiz', 'Quiz del Real Madrid',
    'Real Madrid Quiz — 10 Free Questions', 'Quiz del Real Madrid — 10 Preguntas Gratis',
    'Test your Real Madrid knowledge with {count} verified questions about legendary players, European nights and historic trophies.',
    'Pon a prueba cuánto sabes del Real Madrid con {count} preguntas verificadas sobre jugadores legendarios, noches europeas y trofeos históricos.',
    'About this Real Madrid quiz', 'Sobre este quiz del Real Madrid',
    '[{"id":"paragraph-1","type":"paragraph","text":"From Alfredo Di Stéfano and the first European Cups to Cristiano Ronaldo and the modern Champions League era, Real Madrid has built a history made for football trivia."},{"id":"paragraph-2","type":"paragraph","text":"Answer {count} verified questions, see your score instantly and replay for another challenge. No account is required."}]'::jsonb,
    '[{"id":"paragraph-1","type":"paragraph","text":"Desde Alfredo Di Stéfano y las primeras Copas de Europa hasta Cristiano Ronaldo y la era moderna de la Champions League, el Real Madrid ha construido una historia perfecta para la trivia de fútbol."},{"id":"paragraph-2","type":"paragraph","text":"Responde {count} preguntas verificadas, consulta tu puntuación al instante y vuelve a jugar para afrontar otro reto. No necesitas una cuenta."}]'::jsonb,
    'Real Madrid Quiz: 10 Free Football Questions | QuizBall',
    'Quiz del Real Madrid: 10 Preguntas Gratis | QuizBall',
    'Play a free Real Madrid quiz with {count} verified questions about players, trophies and unforgettable Champions League moments.',
    'Juega gratis a un quiz del Real Madrid con {count} preguntas verificadas sobre jugadores, títulos y momentos inolvidables de la Champions.',
    'Real Madrid players celebrating at the Santiago Bernabéu',
    'Jugadores del Real Madrid celebrando en el Santiago Bernabéu',
    'You scored {score}/{total}. Can you beat it?',
    'Has acertado {score} de {total}. ¿Puedes superarlo?',
    'Think you know Real Madrid? Take your score into a ranked duel.',
    '¿Crees que sabes todo del Real Madrid? Lleva tu puntuación a un duelo clasificatorio.',
    30
  ),
  (
    'barcelona', 'team', 'barcelona',
    'Barcelona Quiz', 'Quiz del Barcelona',
    'FC Barcelona Quiz — 10 Free Questions', 'Quiz del FC Barcelona — 10 Preguntas Gratis',
    'Take a {count}-question Barcelona quiz covering club legends, La Masia, famous teams and defining moments at the Camp Nou.',
    'Juega un quiz del Barcelona de {count} preguntas sobre leyendas del club, La Masia, equipos históricos y momentos decisivos en el Camp Nou.',
    'About this Barcelona quiz', 'Sobre este quiz del Barcelona',
    '[{"id":"paragraph-1","type":"paragraph","text":"Barcelona’s story runs from the club’s Catalan identity and La Masia to Johan Cruyff, Pep Guardiola, Lionel Messi and some of football’s most influential teams."},{"id":"paragraph-2","type":"paragraph","text":"The quiz contains {count} verified questions and gives you an instant score. Play free without creating an account."}]'::jsonb,
    '[{"id":"paragraph-1","type":"paragraph","text":"La historia del Barcelona une la identidad catalana del club y La Masia con Johan Cruyff, Pep Guardiola, Lionel Messi y algunos de los equipos más influyentes del fútbol."},{"id":"paragraph-2","type":"paragraph","text":"El quiz contiene {count} preguntas verificadas y te muestra la puntuación al instante. Juega gratis sin crear una cuenta."}]'::jsonb,
    'Barcelona Quiz: 10 Free Barça Questions | QuizBall',
    'Quiz del Barcelona: 10 Preguntas del Barça | QuizBall',
    'Play a free FC Barcelona quiz with {count} verified questions about Messi, La Masia, trophies and famous Barça teams.',
    'Juega gratis a un quiz del FC Barcelona con {count} preguntas verificadas sobre Messi, La Masia, títulos y equipos históricos del Barça.',
    'FC Barcelona players and supporters at the Camp Nou',
    'Jugadores y aficionados del FC Barcelona en el Camp Nou',
    'You scored {score}/{total}. Can you beat it?',
    'Has acertado {score} de {total}. ¿Puedes superarlo?',
    'Ready for a tougher Barcelona challenge? Play a ranked duel.',
    '¿Preparado para un reto del Barcelona más difícil? Juega un duelo clasificatorio.',
    31
  ),
  (
    'la-liga', 'league', 'la-liga',
    'La Liga Quiz', 'Quiz de LaLiga',
    'La Liga Quiz — 10 Free Questions', 'Quiz de LaLiga — 10 Preguntas Gratis',
    'Answer {count} verified questions about Spanish football champions, iconic players, rivalries and record-breaking seasons.',
    'Responde {count} preguntas verificadas sobre campeones del fútbol español, jugadores icónicos, rivalidades y temporadas de récord.',
    'About this La Liga quiz', 'Sobre este quiz de LaLiga',
    '[{"id":"paragraph-1","type":"paragraph","text":"La Liga has produced era-defining teams, fierce rivalries and generations of world-class players. This quiz ranges across the competition’s clubs and history."},{"id":"paragraph-2","type":"paragraph","text":"Answer {count} checked questions, get your score immediately and replay whenever you want. It is free and needs no account."}]'::jsonb,
    '[{"id":"paragraph-1","type":"paragraph","text":"LaLiga ha producido equipos que marcaron una época, rivalidades intensas y generaciones de futbolistas de talla mundial. Este quiz recorre los clubes y la historia de la competición."},{"id":"paragraph-2","type":"paragraph","text":"Responde {count} preguntas comprobadas, recibe tu puntuación al instante y vuelve a jugar cuando quieras. Es gratis y no necesita cuenta."}]'::jsonb,
    'La Liga Quiz: 10 Free Spanish Football Questions | QuizBall',
    'Quiz de LaLiga: 10 Preguntas de Fútbol Español | QuizBall',
    'Play a free La Liga quiz with {count} verified questions about Spanish clubs, champions, famous players and football history.',
    'Juega gratis a un quiz de LaLiga con {count} preguntas verificadas sobre clubes, campeones, futbolistas famosos e historia del fútbol español.',
    'La Liga footballers competing in a Spanish league match',
    'Futbolistas compitiendo en un partido de LaLiga',
    'You scored {score}/{total}. Can you beat it?',
    'Has acertado {score} de {total}. ¿Puedes superarlo?',
    'Turn your La Liga knowledge into a ranked victory.',
    'Convierte tus conocimientos de LaLiga en una victoria clasificatoria.',
    32
  ),
  (
    'argentina', 'team', 'argentina',
    'Argentina Football Quiz', 'Quiz de la Selección Argentina',
    'Argentina Football Quiz — 10 Free Questions', 'Quiz de Argentina — 10 Preguntas de Fútbol Gratis',
    'Test your Argentina football knowledge with {count} verified questions about world champions, legendary number tens and unforgettable tournaments.',
    'Pon a prueba cuánto sabes de la selección argentina con {count} preguntas verificadas sobre campeones del mundo, números diez legendarios y torneos inolvidables.',
    'About this Argentina football quiz', 'Sobre este quiz de Argentina',
    '[{"id":"paragraph-1","type":"paragraph","text":"Argentina’s football history includes World Cup triumphs, iconic number tens and a national team followed with extraordinary passion around the world."},{"id":"paragraph-2","type":"paragraph","text":"Take {count} verified questions, see your result immediately and play again for free. No registration is required."}]'::jsonb,
    '[{"id":"paragraph-1","type":"paragraph","text":"La historia del fútbol argentino reúne triunfos mundialistas, números diez icónicos y una selección seguida con una pasión extraordinaria en todo el mundo."},{"id":"paragraph-2","type":"paragraph","text":"Responde {count} preguntas verificadas, consulta el resultado al instante y vuelve a jugar gratis. No necesitas registrarte."}]'::jsonb,
    'Argentina Football Quiz: 10 Free Questions | QuizBall',
    'Quiz de Argentina: 10 Preguntas de Fútbol | QuizBall',
    'Play a free Argentina football quiz with {count} verified questions about Messi, Maradona, World Cups and national-team history.',
    'Juega gratis a un quiz de Argentina con {count} preguntas verificadas sobre Messi, Maradona, los Mundiales y la historia de la selección.',
    'Argentina national football team players celebrating',
    'Jugadores de la selección argentina celebrando',
    'You scored {score}/{total}. Can you beat it?',
    'Has acertado {score} de {total}. ¿Puedes superarlo?',
    'Take your Argentina knowledge into a live ranked duel.',
    'Lleva tus conocimientos de Argentina a un duelo clasificatorio en vivo.',
    33
  ),
  (
    'spain', 'team', 'spain',
    'Spain Football Quiz', 'Quiz de la Selección Española',
    'Spain Football Quiz — 10 Free Questions', 'Quiz de España — 10 Preguntas de Fútbol Gratis',
    'Answer {count} verified questions about Spain’s national team, tournament wins, legendary players and defining football moments.',
    'Responde {count} preguntas verificadas sobre la selección española, sus títulos, jugadores legendarios y momentos decisivos.',
    'About this Spain football quiz', 'Sobre este quiz de España',
    '[{"id":"paragraph-1","type":"paragraph","text":"Spain’s national team history stretches from earlier generations to the side that won three consecutive major tournaments between 2008 and 2012."},{"id":"paragraph-2","type":"paragraph","text":"This free quiz gives you {count} checked questions and an instant score. No account is needed, and you can replay whenever you like."}]'::jsonb,
    '[{"id":"paragraph-1","type":"paragraph","text":"La historia de la selección española va desde las primeras generaciones hasta el equipo que ganó tres grandes torneos consecutivos entre 2008 y 2012."},{"id":"paragraph-2","type":"paragraph","text":"Este quiz gratis incluye {count} preguntas comprobadas y te muestra la puntuación al instante. No necesitas cuenta y puedes volver a jugar cuando quieras."}]'::jsonb,
    'Spain Football Quiz: 10 Free Questions | QuizBall',
    'Quiz de España: 10 Preguntas de Fútbol | QuizBall',
    'Play a free Spain football quiz with {count} verified questions about the national team, major tournaments and legendary players.',
    'Juega gratis a un quiz de España con {count} preguntas verificadas sobre la selección, grandes torneos y jugadores legendarios.',
    'Spain national football team players celebrating',
    'Jugadores de la selección española celebrando',
    'You scored {score}/{total}. Can you beat it?',
    'Has acertado {score} de {total}. ¿Puedes superarlo?',
    'Take your Spain knowledge into a live ranked duel.',
    'Lleva tus conocimientos de España a un duelo clasificatorio en vivo.',
    34
  );

CREATE TEMP TABLE spanish_market_quiz_difficulty_seed (
  quiz_slug TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  quota SMALLINT NOT NULL,
  start_order SMALLINT NOT NULL,
  PRIMARY KEY (quiz_slug, difficulty)
) ON COMMIT DROP;

INSERT INTO spanish_market_quiz_difficulty_seed VALUES
  ('real-madrid', 'easy', 4, 1),
  ('real-madrid', 'medium', 3, 5),
  ('real-madrid', 'hard', 3, 8),
  ('barcelona', 'easy', 5, 1),
  ('barcelona', 'medium', 5, 6),
  ('la-liga', 'easy', 4, 1),
  ('la-liga', 'medium', 3, 5),
  ('la-liga', 'hard', 3, 8),
  ('argentina', 'easy', 4, 1),
  ('argentina', 'medium', 3, 5),
  ('argentina', 'hard', 3, 8),
  ('spain', 'easy', 4, 1),
  ('spain', 'medium', 3, 5),
  ('spain', 'hard', 3, 8);

-- Select timeless, fully translated MCQs before replacing any prior copy of
-- these SEO-only sets. The deterministic ordering keeps reruns stable.
CREATE TEMP TABLE spanish_market_question_seed ON COMMIT DROP AS
WITH eligible AS (
  SELECT
    page.slug AS quiz_slug,
    question.id AS source_id,
    question.category_id,
    question.type,
    question.difficulty,
    question.prompt,
    question.explanation,
    payload.payload,
    quota.quota,
    quota.start_order,
    ROW_NUMBER() OVER (
      PARTITION BY page.slug, question.difficulty
      ORDER BY md5(lower(question.prompt->>'en') || question.id::text), question.id
    ) AS difficulty_rank
  FROM spanish_market_quiz_seed page
  JOIN public.categories category ON category.slug = page.source_category_slug
  JOIN public.questions question ON question.category_id = category.id
  JOIN public.question_payloads payload ON payload.question_id = question.id
  JOIN spanish_market_quiz_difficulty_seed quota
    ON quota.quiz_slug = page.slug
   AND quota.difficulty = question.difficulty
  WHERE question.status = 'published'
    AND question.type = 'mcq_single'
    AND question.ranked_eligible = TRUE
    AND COALESCE(question.prompt->>'en', '') <> ''
    AND COALESCE(question.prompt->>'es', '') <> ''
    AND lower(question.prompt->>'en') !~ '(current|currently|this season|2025|2026)'
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
      FROM public.campaign_quiz_manual_questions managed
      WHERE managed.question_id = question.id
    )
), selected AS (
  SELECT *
  FROM eligible
  WHERE difficulty_rank <= quota
), identified AS (
  SELECT
    selected.*,
    md5('quizball-spanish-market-v1:' || quiz_slug || ':' || source_id::text) AS stable_hash
  FROM selected
)
SELECT
  quiz_slug,
  source_id,
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
  payload,
  (start_order + difficulty_rank - 1)::smallint AS display_order
FROM identified;

DO $$
DECLARE
  incomplete TEXT;
BEGIN
  SELECT string_agg(page.slug || ' (' || COALESCE(counts.total, 0) || '/10)', ', ' ORDER BY page.slug)
  INTO incomplete
  FROM spanish_market_quiz_seed page
  LEFT JOIN (
    SELECT quiz_slug, COUNT(*)::int AS total
    FROM spanish_market_question_seed
    GROUP BY quiz_slug
  ) counts ON counts.quiz_slug = page.slug
  WHERE COALESCE(counts.total, 0) <> 10;

  IF incomplete IS NOT NULL THEN
    RAISE EXCEPTION 'Spanish market question selection is incomplete: %', incomplete;
  END IF;
END $$;

INSERT INTO public.campaign_quizzes (
  slug,
  title,
  status,
  internal_name,
  page_category,
  question_set_slug,
  h1,
  lede,
  about_heading,
  about_blocks,
  score_cta,
  footer_banner_text,
  footer_button_label,
  hero_image_url,
  hero_image_alt,
  seo_title,
  meta_description,
  og_image_url,
  og_image_alt,
  breadcrumb_label,
  locale_mode,
  hub_order,
  question_source,
  es_title,
  es_h1,
  es_seo_title,
  es_meta_description,
  es_breadcrumb_label,
  es_lede,
  es_about_heading,
  es_about_blocks,
  es_hero_image_alt,
  es_og_image_alt,
  es_score_cta,
  es_footer_banner_text,
  es_footer_button_label
)
SELECT
  page.slug,
  page.title_en,
  'draft',
  page.title_en,
  page.page_category,
  page.slug,
  page.h1_en,
  page.lede_en,
  page.about_heading_en,
  page.about_blocks_en,
  page.score_cta_en,
  page.footer_banner_en,
  'Play Ranked',
  category.image_url,
  page.image_alt_en,
  page.seo_title_en,
  page.meta_description_en,
  category.image_url,
  page.image_alt_en,
  page.title_en,
  'en_only',
  page.hub_order,
  'manual',
  page.title_es,
  page.h1_es,
  page.seo_title_es,
  page.meta_description_es,
  page.title_es,
  page.lede_es,
  page.about_heading_es,
  page.about_blocks_es,
  page.image_alt_es,
  page.image_alt_es,
  page.score_cta_es,
  page.footer_banner_es,
  'Jugar clasificatoria'
FROM spanish_market_quiz_seed page
JOIN public.categories category ON category.slug = page.source_category_slug
ON CONFLICT (slug) DO UPDATE
SET title = EXCLUDED.title,
    status = 'draft',
    internal_name = EXCLUDED.internal_name,
    page_category = EXCLUDED.page_category,
    question_set_slug = EXCLUDED.question_set_slug,
    h1 = EXCLUDED.h1,
    lede = EXCLUDED.lede,
    about_heading = EXCLUDED.about_heading,
    about_blocks = EXCLUDED.about_blocks,
    score_cta = EXCLUDED.score_cta,
    footer_banner_text = EXCLUDED.footer_banner_text,
    footer_button_label = EXCLUDED.footer_button_label,
    hero_image_url = EXCLUDED.hero_image_url,
    hero_image_alt = EXCLUDED.hero_image_alt,
    seo_title = EXCLUDED.seo_title,
    meta_description = EXCLUDED.meta_description,
    og_image_url = EXCLUDED.og_image_url,
    og_image_alt = EXCLUDED.og_image_alt,
    breadcrumb_label = EXCLUDED.breadcrumb_label,
    locale_mode = EXCLUDED.locale_mode,
    hub_order = EXCLUDED.hub_order,
    question_source = EXCLUDED.question_source,
    es_title = EXCLUDED.es_title,
    es_h1 = EXCLUDED.es_h1,
    es_seo_title = EXCLUDED.es_seo_title,
    es_meta_description = EXCLUDED.es_meta_description,
    es_breadcrumb_label = EXCLUDED.es_breadcrumb_label,
    es_lede = EXCLUDED.es_lede,
    es_about_heading = EXCLUDED.es_about_heading,
    es_about_blocks = EXCLUDED.es_about_blocks,
    es_hero_image_alt = EXCLUDED.es_hero_image_alt,
    es_og_image_alt = EXCLUDED.es_og_image_alt,
    es_score_cta = EXCLUDED.es_score_cta,
    es_footer_banner_text = EXCLUDED.es_footer_banner_text,
    es_footer_button_label = EXCLUDED.es_footer_button_label,
    scheduled_publish_at = NULL,
    unpublished_at = NULL,
    updated_at = NOW();

DELETE FROM public.campaign_quiz_questions assigned
USING spanish_market_quiz_seed page
WHERE assigned.quiz_slug = page.slug;

DELETE FROM public.questions question
USING public.campaign_quiz_manual_questions managed, spanish_market_quiz_seed page
WHERE question.id = managed.question_id
  AND managed.quiz_slug = page.slug;

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
FROM spanish_market_question_seed
ON CONFLICT (id) DO UPDATE
SET category_id = EXCLUDED.category_id,
    type = EXCLUDED.type,
    difficulty = EXCLUDED.difficulty,
    status = EXCLUDED.status,
    prompt = EXCLUDED.prompt,
    explanation = EXCLUDED.explanation,
    ranked_eligible = FALSE,
    visibility = 'public',
    updated_at = NOW();

INSERT INTO public.question_payloads (question_id, payload)
SELECT id, payload
FROM spanish_market_question_seed
ON CONFLICT (question_id) DO UPDATE
SET payload = EXCLUDED.payload,
    updated_at = NOW();

INSERT INTO public.campaign_quiz_questions (
  quiz_slug,
  question_id,
  difficulty,
  display_order
)
SELECT quiz_slug, id, difficulty, display_order
FROM spanish_market_question_seed
ORDER BY quiz_slug, display_order;

INSERT INTO public.campaign_quiz_manual_questions (question_id, quiz_slug)
SELECT id, quiz_slug
FROM spanish_market_question_seed
ON CONFLICT (question_id) DO UPDATE
SET quiz_slug = EXCLUDED.quiz_slug;

DELETE FROM public.campaign_quiz_related_pages relation
USING spanish_market_quiz_seed page
WHERE relation.quiz_slug = page.slug;

INSERT INTO public.campaign_quiz_related_pages (quiz_slug, related_slug, display_order)
VALUES
  ('real-madrid', 'barcelona', 1),
  ('real-madrid', 'la-liga', 2),
  ('real-madrid', 'guess-the-player', 3),
  ('barcelona', 'real-madrid', 1),
  ('barcelona', 'la-liga', 2),
  ('barcelona', 'club-badges', 3),
  ('la-liga', 'real-madrid', 1),
  ('la-liga', 'barcelona', 2),
  ('la-liga', 'guess-the-player', 3),
  ('argentina', 'spain', 1),
  ('argentina', 'guess-the-player', 2),
  ('argentina', 'career-path', 3),
  ('spain', 'argentina', 1),
  ('spain', 'la-liga', 2),
  ('spain', 'career-path', 3);

UPDATE public.campaign_quizzes quiz
SET status = 'published',
    published_at = COALESCE(quiz.published_at, NOW()),
    scheduled_publish_at = NULL,
    unpublished_at = NULL,
    updated_at = NOW()
FROM spanish_market_quiz_seed page
WHERE quiz.slug = page.slug
  AND (
    SELECT COUNT(*)
    FROM public.campaign_quiz_questions assigned
    JOIN public.questions question ON question.id = assigned.question_id
    JOIN public.question_payloads payload ON payload.question_id = question.id
    WHERE assigned.quiz_slug = quiz.question_set_slug
      AND question.status = 'published'
      AND question.visibility = 'public'
      AND question.ranked_eligible = FALSE
      AND COALESCE(question.prompt->>'es', '') <> ''
      AND jsonb_typeof(payload.payload->'options') = 'array'
  ) = 10;

DO $$
DECLARE
  incomplete TEXT;
BEGIN
  SELECT string_agg(page.slug, ', ' ORDER BY page.slug)
  INTO incomplete
  FROM spanish_market_quiz_seed page
  JOIN public.campaign_quizzes quiz ON quiz.slug = page.slug
  WHERE quiz.status <> 'published';

  IF incomplete IS NOT NULL THEN
    RAISE EXCEPTION 'Spanish market campaign pages are not publishable: %', incomplete;
  END IF;
END $$;

COMMIT;
