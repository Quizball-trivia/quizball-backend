-- Possession v1 engine support:
-- - dual-engine matches (classic + possession_v1)
-- - phase metadata on questions/answers
-- - goal tracking per player
-- - relaxed q_index range for dynamic phases (normal/shot/penalty)

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'classic',
  ADD COLUMN IF NOT EXISTS state_payload jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'matches_engine_check'
      AND conrelid = 'public.matches'::regclass
  ) THEN
    ALTER TABLE public.matches
      ADD CONSTRAINT matches_engine_check
      CHECK (engine IN ('classic', 'possession_v1'));
  END IF;
END $$;

ALTER TABLE public.match_players
  ADD COLUMN IF NOT EXISTS goals integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS penalty_goals integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'match_players_goals_check'
      AND conrelid = 'public.match_players'::regclass
  ) THEN
    ALTER TABLE public.match_players
      ADD CONSTRAINT match_players_goals_check CHECK (goals >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'match_players_penalty_goals_check'
      AND conrelid = 'public.match_players'::regclass
  ) THEN
    ALTER TABLE public.match_players
      ADD CONSTRAINT match_players_penalty_goals_check CHECK (penalty_goals >= 0);
  END IF;
END $$;

ALTER TABLE public.match_questions
  DROP CONSTRAINT IF EXISTS match_questions_q_index_check;

ALTER TABLE public.match_questions
  ADD CONSTRAINT match_questions_q_index_check CHECK (q_index >= 0);

ALTER TABLE public.match_answers
  DROP CONSTRAINT IF EXISTS match_answers_q_index_check;

ALTER TABLE public.match_answers
  ADD CONSTRAINT match_answers_q_index_check CHECK (q_index >= 0);

ALTER TABLE public.match_questions
  ADD COLUMN IF NOT EXISTS phase_kind text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS phase_round integer,
  ADD COLUMN IF NOT EXISTS shooter_seat smallint,
  ADD COLUMN IF NOT EXISTS attacker_seat smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'match_questions_phase_kind_check'
      AND conrelid = 'public.match_questions'::regclass
  ) THEN
    ALTER TABLE public.match_questions
      ADD CONSTRAINT match_questions_phase_kind_check
      CHECK (phase_kind IN ('normal', 'shot', 'penalty'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'match_questions_shooter_seat_check'
      AND conrelid = 'public.match_questions'::regclass
  ) THEN
    ALTER TABLE public.match_questions
      ADD CONSTRAINT match_questions_shooter_seat_check
      CHECK (shooter_seat IS NULL OR shooter_seat IN (1, 2));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'match_questions_attacker_seat_check'
      AND conrelid = 'public.match_questions'::regclass
  ) THEN
    ALTER TABLE public.match_questions
      ADD CONSTRAINT match_questions_attacker_seat_check
      CHECK (attacker_seat IS NULL OR attacker_seat IN (1, 2));
  END IF;
END $$;

ALTER TABLE public.match_answers
  ADD COLUMN IF NOT EXISTS phase_kind text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS phase_round integer,
  ADD COLUMN IF NOT EXISTS shooter_seat smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'match_answers_phase_kind_check'
      AND conrelid = 'public.match_answers'::regclass
  ) THEN
    ALTER TABLE public.match_answers
      ADD CONSTRAINT match_answers_phase_kind_check
      CHECK (phase_kind IN ('normal', 'shot', 'penalty'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'match_answers_shooter_seat_check'
      AND conrelid = 'public.match_answers'::regclass
  ) THEN
    ALTER TABLE public.match_answers
      ADD CONSTRAINT match_answers_shooter_seat_check
      CHECK (shooter_seat IS NULL OR shooter_seat IN (1, 2));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS matches_engine_status_idx
  ON public.matches (engine, status);

CREATE INDEX IF NOT EXISTS match_questions_match_phase_idx
  ON public.match_questions (match_id, phase_kind, q_index);

CREATE INDEX IF NOT EXISTS match_answers_match_phase_idx
  ON public.match_answers (match_id, phase_kind, q_index);
