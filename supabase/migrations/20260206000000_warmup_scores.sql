CREATE TABLE warmup_player_bests (
  user_id       UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  best_score    INTEGER NOT NULL DEFAULT 0,
  total_games   INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE warmup_pair_bests (
  user_a_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  user_b_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  best_score    INTEGER NOT NULL DEFAULT 0,
  total_games   INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a_id, user_b_id),
  CHECK (user_a_id < user_b_id)
);
