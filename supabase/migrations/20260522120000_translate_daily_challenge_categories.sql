-- Adds Georgian translations to the daily-challenge category names + descriptions.
--
-- Companion to 20260330020000_seed_daily_challenge_categories.sql, which seeded
-- the 6 child categories + parent with English-only i18n payloads. Frontend now
-- ships in Georgian by default for Georgian users, so each `name` / `description`
-- jsonb needs the matching `ka` key alongside `en`.
--
-- jsonb_set with `true` (create_missing) lets this run idempotently even when
-- an admin has already populated the field manually.

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', to_jsonb('დღიური გამოწვევები'::text), true),
    description = jsonb_set(description::jsonb, '{ka}', to_jsonb('კონტენტის პულები დღიური გამოწვევის რეჟიმებისთვის.'::text), true),
    updated_at = NOW()
WHERE slug = 'daily-challenges';

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', to_jsonb('ფულის ვარდნა'::text), true),
    description = jsonb_set(description::jsonb, '{ka}', to_jsonb('კითხვები ფულის ვარდნის დღიური გამოწვევისთვის.'::text), true),
    updated_at = NOW()
WHERE slug = 'daily-challenges-money-drop';

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', to_jsonb('საფეხბურთო ჯეოპარდი'::text), true),
    description = jsonb_set(description::jsonb, '{ka}', to_jsonb('კითხვები საფეხბურთო ჯეოპარდის დღიური გამოწვევისთვის.'::text), true),
    updated_at = NOW()
WHERE slug = 'daily-challenges-football-jeopardy';

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', to_jsonb('მართალია თუ მცდარი'::text), true),
    description = jsonb_set(description::jsonb, '{ka}', to_jsonb('კითხვები „მართალია თუ მცდარი" დღიური გამოწვევისთვის.'::text), true),
    updated_at = NOW()
WHERE slug = 'daily-challenges-true-false';

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', to_jsonb('უკუთვლა'::text), true),
    description = jsonb_set(description::jsonb, '{ka}', to_jsonb('კითხვები უკუთვლის დღიური გამოწვევისთვის.'::text), true),
    updated_at = NOW()
WHERE slug = 'daily-challenges-countdown';

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', to_jsonb('მინიშნებები'::text), true),
    description = jsonb_set(description::jsonb, '{ka}', to_jsonb('კითხვები მინიშნებების დღიური გამოწვევისთვის.'::text), true),
    updated_at = NOW()
WHERE slug = 'daily-challenges-clues';

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', to_jsonb('დაალაგე რიგით'::text), true),
    description = jsonb_set(description::jsonb, '{ka}', to_jsonb('კითხვები „დაალაგე რიგით" დღიური გამოწვევისთვის.'::text), true),
    updated_at = NOW()
WHERE slug = 'daily-challenges-put-in-order';
