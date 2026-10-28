-- Fake Fact (Dato falso, spot the fake) joins the Freecroco games. Added NOT VALID, validated in 20261027120010,
-- swapped for the old check in 20261027120020 (the 20261020120100 pattern). 'guess-the-goal' stays allowed: its rows
-- and history are kept, only switched off (20261027120030).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_partner_games_game_v2' AND conrelid = 'public.partner_games'::regclass) THEN
    ALTER TABLE public.partner_games ADD CONSTRAINT chk_partner_games_game_v2 CHECK (game_id IN ('ranked', 'countdown',
      'true-false', 'pick-em', 'career-path', 'higher-lower', 'card-detective', 'guess-the-goal', 'road-to-goal',
      'trivia-mines', 'quiz-board', 'fake-fact')) NOT VALID;
  END IF;
END $$;
