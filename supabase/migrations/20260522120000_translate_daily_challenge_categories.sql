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
SET name = jsonb_set(name::jsonb, '{ka}', '"დღიური გამოწვევები"', true),
    description = jsonb_set(description::jsonb, '{ka}', '"კონტენტის პულები დღიური გამოწვევის რეჟიმებისთვის."', true),
    updated_at = NOW()
WHERE slug = 'daily-challenges';

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', '"ფულის ვარდნა"', true),
    description = jsonb_set(description::jsonb, '{ka}', '"კითხვები ფულის ვარდნის დღიური გამოწვევისთვის."', true),
    updated_at = NOW()
WHERE slug = 'daily-challenges-money-drop';

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', '"საფეხბურთო ჯეოპარდი"', true),
    description = jsonb_set(description::jsonb, '{ka}', '"კითხვები საფეხბურთო ჯეოპარდის დღიური გამოწვევისთვის."', true),
    updated_at = NOW()
WHERE slug = 'daily-challenges-football-jeopardy';

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', '"მართალია თუ მცდარი"', true),
    description = jsonb_set(description::jsonb, '{ka}', '"კითხვები „მართალია თუ მცდარი" დღიური გამოწვევისთვის."', true),
    updated_at = NOW()
WHERE slug = 'daily-challenges-true-false';

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', '"უკუთვლა"', true),
    description = jsonb_set(description::jsonb, '{ka}', '"კითხვები უკუთვლის დღიური გამოწვევისთვის."', true),
    updated_at = NOW()
WHERE slug = 'daily-challenges-countdown';

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', '"მინიშნებები"', true),
    description = jsonb_set(description::jsonb, '{ka}', '"კითხვები მინიშნებების დღიური გამოწვევისთვის."', true),
    updated_at = NOW()
WHERE slug = 'daily-challenges-clues';

UPDATE categories
SET name = jsonb_set(name::jsonb, '{ka}', '"დაალაგე რიგით"', true),
    description = jsonb_set(description::jsonb, '{ka}', '"კითხვები „დაალაგე რიგით" დღიური გამოწვევისთვის."', true),
    updated_at = NOW()
WHERE slug = 'daily-challenges-put-in-order';
