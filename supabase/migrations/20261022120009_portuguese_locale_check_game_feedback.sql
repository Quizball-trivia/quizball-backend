-- Portuguese (pt) becomes a locale: game_feedback's locale check, widened NOT VALID (validated later under a weaker lock).
-- One table per migration: each runs in its own transaction, so no table's lock waits on another's.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.game_feedback
  DROP CONSTRAINT IF EXISTS chk_game_feedback_locale,
  ADD CONSTRAINT chk_game_feedback_locale
    CHECK (locale IN ('en', 'ka', 'es', 'tr', 'ru', 'pt')) NOT VALID;
