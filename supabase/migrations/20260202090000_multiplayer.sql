-- Multiplayer lobbies + matches (friendly + ranked only)

CREATE TABLE public.lobbies (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invite_code text UNIQUE,
  mode text NOT NULL CHECK (mode IN ('friendly', 'ranked')),
  host_user_id uuid NOT NULL REFERENCES public.users(id),
  status text NOT NULL CHECK (status IN ('waiting', 'active', 'closed')),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT lobbies_pkey PRIMARY KEY (id),
  CONSTRAINT lobbies_invite_code_mode_check CHECK (
    (mode = 'friendly' AND invite_code IS NOT NULL) OR
    (mode = 'ranked' AND invite_code IS NULL)
  )
);

CREATE TABLE public.lobby_members (
  lobby_id uuid NOT NULL REFERENCES public.lobbies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  is_ready boolean NOT NULL DEFAULT false,
  joined_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT lobby_members_pkey PRIMARY KEY (lobby_id, user_id)
);

CREATE TABLE public.lobby_categories (
  lobby_id uuid NOT NULL REFERENCES public.lobbies(id) ON DELETE CASCADE,
  slot integer NOT NULL CHECK (slot BETWEEN 1 AND 4),
  category_id uuid NOT NULL REFERENCES public.categories(id),
  CONSTRAINT lobby_categories_pkey PRIMARY KEY (lobby_id, slot),
  CONSTRAINT lobby_categories_unique UNIQUE (lobby_id, category_id)
);

CREATE TABLE public.lobby_category_bans (
  lobby_id uuid NOT NULL REFERENCES public.lobbies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id),
  banned_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT lobby_category_bans_pkey PRIMARY KEY (lobby_id, user_id),
  CONSTRAINT lobby_category_bans_unique UNIQUE (lobby_id, category_id)
);

CREATE TABLE public.matches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lobby_id uuid REFERENCES public.lobbies(id) ON DELETE SET NULL,
  mode text NOT NULL CHECK (mode IN ('friendly', 'ranked')),
  status text NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')),
  category_a_id uuid NOT NULL REFERENCES public.categories(id),
  category_b_id uuid NOT NULL REFERENCES public.categories(id),
  current_q_index integer NOT NULL DEFAULT 0,
  total_questions integer NOT NULL DEFAULT 10,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone,
  winner_user_id uuid REFERENCES public.users(id),
  CONSTRAINT matches_pkey PRIMARY KEY (id)
);

CREATE TABLE public.match_players (
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  seat smallint NOT NULL CHECK (seat IN (1, 2)),
  total_points integer NOT NULL DEFAULT 0,
  correct_answers integer NOT NULL DEFAULT 0,
  avg_time_ms integer,
  CONSTRAINT match_players_pkey PRIMARY KEY (match_id, user_id),
  CONSTRAINT match_players_seat_unique UNIQUE (match_id, seat)
);

CREATE TABLE public.match_questions (
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  q_index integer NOT NULL CHECK (q_index BETWEEN 0 AND 9),
  question_id uuid NOT NULL REFERENCES public.questions(id),
  category_id uuid NOT NULL REFERENCES public.categories(id),
  correct_index integer NOT NULL CHECK (correct_index BETWEEN 0 AND 3),
  shown_at timestamp with time zone,
  deadline_at timestamp with time zone,
  CONSTRAINT match_questions_pkey PRIMARY KEY (match_id, q_index),
  CONSTRAINT match_questions_unique UNIQUE (match_id, question_id)
);

CREATE TABLE public.match_answers (
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  q_index integer NOT NULL CHECK (q_index BETWEEN 0 AND 9),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  selected_index integer CHECK (selected_index BETWEEN 0 AND 3),
  is_correct boolean NOT NULL,
  time_ms integer NOT NULL,
  points_earned integer NOT NULL,
  answered_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT match_answers_pkey PRIMARY KEY (match_id, q_index, user_id)
);

CREATE INDEX lobbies_invite_code_waiting_idx
  ON public.lobbies (invite_code)
  WHERE mode = 'friendly' AND status = 'waiting';

CREATE INDEX matches_status_active_idx
  ON public.matches (status)
  WHERE status = 'active';

CREATE INDEX match_questions_match_id_idx
  ON public.match_questions (match_id);

CREATE INDEX match_answers_match_id_idx
  ON public.match_answers (match_id);
