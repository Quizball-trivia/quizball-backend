WITH upsert_parent AS (
  INSERT INTO categories (
    slug,
    parent_id,
    name,
    description,
    icon,
    image_url,
    is_active
  )
  VALUES (
    'daily-challenges',
    NULL,
    '{"en":"Daily Challenges"}'::jsonb,
    '{"en":"Content pools used by the daily challenge game modes."}'::jsonb,
    'zap',
    NULL,
    true
  )
  ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    icon = EXCLUDED.icon,
    image_url = EXCLUDED.image_url,
    is_active = EXCLUDED.is_active,
    updated_at = NOW()
  RETURNING id
)
INSERT INTO categories (
  slug,
  parent_id,
  name,
  description,
  icon,
  image_url,
  is_active
)
SELECT
  seed.slug,
  parent.id,
  seed.name::jsonb,
  seed.description::jsonb,
  seed.icon,
  NULL,
  true
FROM upsert_parent parent
CROSS JOIN (
  VALUES
    (
      'daily-challenges-money-drop',
      '{"en":"Money Drop"}',
      '{"en":"Questions reserved for the Money Drop daily challenge."}',
      'dollar-sign'
    ),
    (
      'daily-challenges-football-jeopardy',
      '{"en":"Football Jeopardy"}',
      '{"en":"Questions reserved for the Football Jeopardy daily challenge."}',
      'brain'
    ),
    (
      'daily-challenges-true-false',
      '{"en":"True or False"}',
      '{"en":"Questions reserved for the True or False daily challenge."}',
      'check-circle'
    ),
    (
      'daily-challenges-countdown',
      '{"en":"Countdown"}',
      '{"en":"Questions reserved for the Countdown daily challenge."}',
      'timer'
    ),
    (
      'daily-challenges-clues',
      '{"en":"Clues"}',
      '{"en":"Questions reserved for the Clues daily challenge."}',
      'lightbulb'
    ),
    (
      'daily-challenges-put-in-order',
      '{"en":"Put In Order"}',
      '{"en":"Questions reserved for the Put In Order daily challenge."}',
      'list-ordered'
    )
) AS seed(slug, name, description, icon)
ON CONFLICT (slug) DO UPDATE SET
  parent_id = EXCLUDED.parent_id,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();
