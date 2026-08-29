BEGIN;

-- Keep this content-only migration fast and fail closed rather than waiting on
-- gameplay traffic. Only rows that still lack Spanish are touched.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

UPDATE public.categories AS category
SET
  name = jsonb_set(
    COALESCE(category.name, '{}'::jsonb),
    '{es}',
    to_jsonb(translations.es_name),
    true
  ),
  updated_at = now()
FROM (
  VALUES
    ('aston-villa', 'Aston Villa'),
    ('bournemouth', 'Bournemouth'),
    ('brentford', 'Brentford'),
    ('brighton', 'Brighton'),
    ('club-badges', 'Quiz de Escudos de Clubes'),
    ('copaamerica', 'Copa América'),
    ('coventry-city', 'Coventry City'),
    ('crystal-palace', 'Crystal Palace'),
    ('dinamo-tbs', 'Dinamo Tiflis'),
    ('fulham', 'Fulham'),
    ('georgia-world-cup', 'Georgianos en la Copa Mundial'),
    ('golden-boot-legends', 'Leyendas de la Bota de Oro'),
    ('hull-city', 'Hull City'),
    ('iconic-world-cup-moments', 'Momentos Icónicos de la Copa Mundial'),
    ('ipswich-town', 'Ipswich Town'),
    ('leeds-united', 'Leeds United'),
    ('newcastle-united', 'Newcastle United'),
    ('nottingham-forest', 'Nottingham Forest'),
    ('sunderland', 'Sunderland')
) AS translations(slug, es_name)
WHERE category.slug = translations.slug
  AND COALESCE(category.name->>'es', '') = '';

UPDATE public.categories AS category
SET
  description = jsonb_set(
    COALESCE(category.description, '{}'::jsonb),
    '{es}',
    to_jsonb(translations.es_description),
    true
  ),
  updated_at = now()
FROM (
  VALUES
    ('dinamo-tbs', 'El club de fútbol más famoso de Georgia.'),
    ('georgia-world-cup', 'Héroes del fútbol georgiano e historias de la Copa Mundial.'),
    ('golden-boot-legends', 'Los goleadores más letales de la historia de la Copa Mundial.'),
    ('iconic-world-cup-moments', 'Momentos que cambiaron el fútbol para siempre.')
) AS translations(slug, es_description)
WHERE category.slug = translations.slug
  AND COALESCE(category.description->>'es', '') = '';

UPDATE public.store_products AS product
SET
  name = CASE
    WHEN COALESCE(product.name->>'es', '') = '' THEN jsonb_set(
      COALESCE(product.name, '{}'::jsonb),
      '{es}',
      to_jsonb(translations.es_name),
      true
    )
    ELSE product.name
  END,
  description = CASE
    WHEN COALESCE(product.description->>'es', '') = '' THEN jsonb_set(
      COALESCE(product.description, '{}'::jsonb),
      '{es}',
      to_jsonb(translations.es_description),
      true
    )
    ELSE product.description
  END
FROM (
  VALUES
    ('avatar_skin_dark', 'Piel Morena', 'Tono de piel para el avatar por capas.'),
    ('avatar_skin_dark_alt', 'Piel Oscura', 'Tono de piel para el avatar por capas.'),
    ('avatar_skin_white_alt', 'Piel Bronceada', 'Tono de piel para el avatar por capas.'),
    ('ticket_pack_10', '10 Entradas de Arena — Recarga Completa', 'Recarga hasta el límite de 10 entradas.'),
    ('ticket_pack_25', '25 Entradas de Arena', 'Paquete de entradas para jugar más partidas.')
) AS translations(slug, es_name, es_description)
WHERE product.slug = translations.slug
  AND (
    COALESCE(product.name->>'es', '') = ''
    OR COALESCE(product.description->>'es', '') = ''
  );

COMMIT;
