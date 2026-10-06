-- Room games, part 3 of 3: seats and the command inbox. Its own transaction, so the users foreign key's brief lock
-- is never taken while a lobbies lock is held.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.room_seats (
  match_id uuid NOT NULL REFERENCES public.room_matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Join order in the room (0–5); the engine index is `seat`, set when the ready gate admits the seat.
  slot smallint NOT NULL,
  seat smallint,
  admitted boolean NOT NULL DEFAULT false,
  is_guest boolean NOT NULL DEFAULT false,
  locale text NOT NULL DEFAULT 'es',
  ready_at timestamptz,
  -- Presence: no socket (after a short debounce) = away with its own deadline; time away is charged to a per-match budget.
  connected boolean NOT NULL DEFAULT true,
  absent_since timestamptz,
  absence_deadline_at timestamptz,
  absence_used_ms integer NOT NULL DEFAULT 0,
  presence_gen integer NOT NULL DEFAULT 0,
  -- Set when the player left on purpose (at the gate or mid-match); withdrawn by absence or left out at the gate = null.
  left_at timestamptz,
  place smallint,
  points integer,
  -- True while the seat holds the user (live match, not withdrawn / not left out at the gate).
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (match_id, user_id),
  CONSTRAINT uq_room_seats_slot UNIQUE (match_id, slot),
  CONSTRAINT chk_room_seats_slot CHECK (slot BETWEEN 0 AND 5),
  CONSTRAINT chk_room_seats_seat CHECK (seat IS NULL OR seat BETWEEN 0 AND 5),
  CONSTRAINT chk_room_seats_admitted CHECK (admitted = (seat IS NOT NULL)),
  CONSTRAINT chk_room_seats_locale CHECK (locale IN ('es', 'en', 'ka', 'tr'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_room_seats_engine_seat ON public.room_seats (match_id, seat) WHERE seat IS NOT NULL;
-- The database itself refuses a second live room seat for the same person.
CREATE UNIQUE INDEX IF NOT EXISTS uq_room_seats_one_live ON public.room_seats (user_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_room_seats_user ON public.room_seats (user_id, match_id);

-- Idempotent inbox: a retried command returns its stored result; the same id with other content is refused.
CREATE TABLE IF NOT EXISTS public.room_commands (
  match_id uuid NOT NULL REFERENCES public.room_matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  command_id uuid NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id, command_id)
);

ALTER TABLE public.room_seats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.room_seats, public.room_commands FROM PUBLIC, anon, authenticated;
