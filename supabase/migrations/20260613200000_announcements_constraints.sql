-- Tighten the announcements table at the DB layer (the API already validates
-- via Zod; these are the matching backstops). Added as a separate migration
-- because the table already shipped without them.
--
-- 1. title/body must carry at least the English key (the EN/KA i18n contract).
-- 2. the publish window must not be reversed (active_from <= active_to).
--
-- Idempotent: drop any prior copy before adding.

ALTER TABLE public.announcements
  DROP CONSTRAINT IF EXISTS announcements_title_has_en,
  DROP CONSTRAINT IF EXISTS announcements_body_has_en,
  DROP CONSTRAINT IF EXISTS announcements_valid_window;

ALTER TABLE public.announcements
  ADD CONSTRAINT announcements_title_has_en
    CHECK (title ? 'en' AND length(title->>'en') > 0),
  ADD CONSTRAINT announcements_body_has_en
    CHECK (body ? 'en' AND length(body->>'en') > 0),
  ADD CONSTRAINT announcements_valid_window
    CHECK (active_from IS NULL OR active_to IS NULL OR active_from <= active_to);
