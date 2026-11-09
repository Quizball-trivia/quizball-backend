-- Freecroco asked to halve Quiz Board's points: tiles are now worth 50 / 100 / 150. Boards already dealt keep their
-- 100 / 200 / 300 rows, so the checks allow both. One table per migration; added NOT VALID, validated in
-- 20261109120020 / 025, swapped in 20261109120030 and 20261109120040.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_partner_quiz_board_tiles_difficulty_v2' AND conrelid = 'public.partner_quiz_board_tiles'::regclass) THEN
    ALTER TABLE public.partner_quiz_board_tiles ADD CONSTRAINT chk_partner_quiz_board_tiles_difficulty_v2 CHECK (
      (difficulty, value) IN (('easy', 50), ('medium', 100), ('hard', 150), ('easy', 100), ('medium', 200), ('hard', 300))
    ) NOT VALID;
  END IF;
END $$;
