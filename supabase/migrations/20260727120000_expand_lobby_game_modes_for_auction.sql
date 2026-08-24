-- Lock-hardened for prod promotion (2026-08-24): lobbies is a live gameplay
-- table; a queued ACCESS EXCLUSIVE here would block lobby traffic behind it.
-- Fail fast instead — an aborted deploy is retryable, blocked players are not.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.lobbies
  DROP CONSTRAINT IF EXISTS lobbies_game_mode_check;

ALTER TABLE public.lobbies
  ADD CONSTRAINT lobbies_game_mode_check
  CHECK (game_mode IN ('friendly_possession', 'friendly_party_quiz', 'auction', 'ranked_sim'));
