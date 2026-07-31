-- =============================================================================
-- Migration: weekend_league_foundations
-- Description: Weekend League (WL) — weekly qualification (QP) + Saturday
--              gauntlet tournament + Sunday final. This migration carries the
--              full durable schema so later engine PRs are code-only:
--
--   wl_qp_awards / wl_qp   QP ledger + read-model totals. The ledger row is
--                          inserted inside the ranked settlement transaction,
--                          fed FROM the settlement's `inserted` CTE, so QP is
--                          exactly-once per (match, user) across the normal,
--                          forfeit and replay settlement paths. Totals are
--                          derivable (SUM) from the ledger at any time.
--   wl_tournaments         One row per event. Status is a CAS-driven state
--                          machine; week_key is the Saturday (Georgia date);
--                          test tournaments (is_test) may reuse a week.
--   wl_entries             Entry + check-in + outcome per user per tournament.
--   wl_questions           Frozen per-tournament content: slot rows (game/
--                          round/question indexes) plus per-(game,kind) reserve
--                          rows (NULL slot coords) used to replace crash-voided
--                          attempts. Never served from the public bank at play
--                          time — payloads are copied at seeding.
--   wl_question_runs       Durable per-attempt truth (dispatched → frozen →
--                          revealed | voided) with Redis-time stamps. Recovery
--                          and results derive from runs + answers, never from
--                          in-flight Redis state.
--   wl_game_participants   The frozen field of each game — makes missed-answer
--                          derivation (participants minus answer rows)
--                          deterministic for scoring and recovery.
--   wl_answers             Accepted answers, persisted at freeze BEFORE any
--                          reveal broadcast.
--   wl_game_results        Final per-game ranking (unique rank per game).
--   wl_events              Transactional outbox of PUBLIC critical events with
--                          a per-tournament gapless sequence; also drives the
--                          spectator feed (visible 30s after live emission).
--   wl_awards              Immutable prize entitlements + manual fulfillment
--                          state; wl_award_actions is its append-only audit.
--
-- questions.visibility: 'wl_private' rows are competition-only content and are
-- excluded from EVERY player-facing selection surface (solo list/get, match
-- pickers, lobby counts, daily challenges, campaign quizzes). The public bank
-- is enumerable with answers by any authenticated player (solo mode evaluates
-- client-side), so prize-tournament content must never enter it.
--
-- notifications: the type CHECK is replaced to admit 'weekend_league', and
-- source_event_key enables recipient-level idempotent notification waves.
--
-- All wl_* tables: RLS enabled with NO policies (deny-all; the service role
-- bypasses RLS) — house convention for backend-owned tables.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- questions.visibility
-- -----------------------------------------------------------------------------

ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'wl_private'));

-- Public-surface hot path: status filters are always paired with the
-- visibility predicate after this migration.
CREATE INDEX IF NOT EXISTS idx_questions_status_visibility
  ON public.questions (status, visibility);

-- -----------------------------------------------------------------------------
-- QP ledger + totals
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.wl_qp_awards (
  match_id uuid NOT NULL,
  -- CASCADE: accounts are anonymized in prod, never hard-deleted; hard deletes
  -- (test teardown, ops cleanup) must not be blocked by QP history.
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  week_key date NOT NULL,
  points integer NOT NULL CHECK (points > 0),
  result text NOT NULL CHECK (result IN ('win', 'loss')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (match_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_wl_qp_awards_week_user
  ON public.wl_qp_awards (week_key, user_id);

CREATE TABLE IF NOT EXISTS public.wl_qp (
  week_key date NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  points integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  wins integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  last_match_at timestamptz,
  PRIMARY KEY (week_key, user_id)
);

-- Qualification leaderboard reads.
CREATE INDEX IF NOT EXISTS idx_wl_qp_week_points
  ON public.wl_qp (week_key, points DESC);

-- -----------------------------------------------------------------------------
-- Tournament + entries
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.wl_tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_key date,
  is_test boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN (
    'scheduled', 'content_pending', 'ready', 'entry_open', 'entry_closed',
    'checkin', 'game_live', 'break', 'qualifier_done', 'final_checkin',
    'final_live', 'completed', 'cancelled', 'voided', 'paused'
  )),
  paused_from_status text,
  no_show_policy text NOT NULL DEFAULT 'dns_v1' CHECK (no_show_policy IN ('dns_v1')),
  final_played boolean NOT NULL DEFAULT true,
  stage jsonb,
  ladder jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_event_seq bigint NOT NULL DEFAULT 0,
  live_delivered_seq bigint NOT NULL DEFAULT 0,
  spec_delivered_seq bigint NOT NULL DEFAULT 0,
  entry_opens_at timestamptz,
  entry_closes_at timestamptz,
  qualifier_starts_at timestamptz,
  final_starts_at timestamptz,
  champion_user_id uuid REFERENCES public.users(id),
  cancelled_reason text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (paused_from_status IS NULL OR status = 'paused')
);

-- One real tournament per week; compressed test tournaments may reuse weeks.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wl_tournaments_week_key
  ON public.wl_tournaments (week_key)
  WHERE is_test = false;

-- The orchestrator's "current tournament" lookup.
CREATE INDEX IF NOT EXISTS idx_wl_tournaments_active
  ON public.wl_tournaments (created_at DESC)
  WHERE status NOT IN ('completed', 'cancelled', 'voided');

-- The no-show policy is part of the competitive contract for an event: it may
-- never change after creation (results/prize adjudication depend on it).
CREATE OR REPLACE FUNCTION public.wl_tournaments_policy_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.no_show_policy IS DISTINCT FROM OLD.no_show_policy THEN
    RAISE EXCEPTION 'wl_tournaments.no_show_policy is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wl_tournaments_policy_immutable ON public.wl_tournaments;
CREATE TRIGGER trg_wl_tournaments_policy_immutable
  BEFORE UPDATE ON public.wl_tournaments
  FOR EACH ROW EXECUTE FUNCTION public.wl_tournaments_policy_immutable();

CREATE TABLE IF NOT EXISTS public.wl_entries (
  tournament_id uuid NOT NULL REFERENCES public.wl_tournaments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id),
  entered_at timestamptz NOT NULL DEFAULT NOW(),
  qp_at_entry integer NOT NULL DEFAULT 0,
  checked_in_at timestamptz,
  final_checked_in_at timestamptz,
  state text NOT NULL DEFAULT 'entered' CHECK (state IN (
    'entered', 'playing', 'eliminated', 'finalist', 'champion',
    'no_show', 'withdrawn', 'disqualified', 'cancelled'
  )),
  eliminated_game integer,
  final_rank integer,
  PRIMARY KEY (tournament_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_wl_entries_state
  ON public.wl_entries (tournament_id, state);

-- -----------------------------------------------------------------------------
-- Content + runs + answers + results
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.wl_questions (
  question_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.wl_tournaments(id) ON DELETE CASCADE,
  game_index integer NOT NULL,
  round_index integer,
  question_index integer,
  reserve_ordinal integer NOT NULL DEFAULT 0,
  kind text NOT NULL CHECK (kind IN (
    'true_false', 'higher_lower', 'mcq', 'career_path', 'who_am_i'
  )),
  payload jsonb NOT NULL,
  evaluation jsonb NOT NULL,
  source_question_id uuid REFERENCES public.questions(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  -- Slot rows carry coordinates; reserve rows carry NONE (they are drawn per
  -- (game, kind) when a crash voids an attempt), so a run's slot coordinates
  -- can never disagree with its content row.
  CHECK (
    (round_index IS NOT NULL AND question_index IS NOT NULL AND reserve_ordinal = 0)
    OR (round_index IS NULL AND question_index IS NULL AND reserve_ordinal > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wl_questions_slot
  ON public.wl_questions (tournament_id, game_index, round_index, question_index)
  WHERE reserve_ordinal = 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wl_questions_reserve
  ON public.wl_questions (tournament_id, game_index, kind, reserve_ordinal)
  WHERE reserve_ordinal > 0;

-- Composite FK target: a run referencing (question_id, tournament_id,
-- game_index) can only point at content from ITS OWN tournament and game.
ALTER TABLE public.wl_questions
  ADD CONSTRAINT uq_wl_questions_id_scope UNIQUE (question_id, tournament_id, game_index);

CREATE TABLE IF NOT EXISTS public.wl_question_runs (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.wl_tournaments(id) ON DELETE CASCADE,
  game_index integer NOT NULL,
  round_index integer NOT NULL,
  question_index integer NOT NULL,
  question_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'dispatched', 'frozen', 'revealed', 'voided'
  )),
  void_reason text,
  playable_at_ms bigint,
  deadline_at_ms bigint,
  dispatched_seq bigint,
  revealed_seq bigint,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (game_index >= 0 AND round_index >= 0 AND question_index >= 0),
  CHECK (deadline_at_ms IS NULL OR playable_at_ms IS NULL OR deadline_at_ms > playable_at_ms),
  -- Cross-row identity: the referenced content row must belong to the same
  -- tournament and game as the run itself.
  FOREIGN KEY (question_id, tournament_id, game_index)
    REFERENCES public.wl_questions (question_id, tournament_id, game_index),
  UNIQUE (attempt_id, tournament_id, game_index)
);

-- One live (non-voided) attempt per slot; voided attempts keep history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wl_question_runs_slot_live
  ON public.wl_question_runs (tournament_id, game_index, round_index, question_index)
  WHERE status <> 'voided';

CREATE TABLE IF NOT EXISTS public.wl_game_participants (
  tournament_id uuid NOT NULL REFERENCES public.wl_tournaments(id) ON DELETE CASCADE,
  game_index integer NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id),
  PRIMARY KEY (tournament_id, game_index, user_id)
);

CREATE TABLE IF NOT EXISTS public.wl_answers (
  attempt_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id),
  tournament_id uuid NOT NULL,
  game_index integer NOT NULL,
  answer jsonb NOT NULL,
  correct boolean NOT NULL,
  points integer NOT NULL CHECK (points >= 0),
  elapsed_ms integer NOT NULL CHECK (elapsed_ms >= 0),
  time_charge_ms integer NOT NULL CHECK (time_charge_ms >= 0),
  timing_source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (attempt_id, user_id),
  -- The answer's denormalized coordinates must agree with its attempt's.
  FOREIGN KEY (attempt_id, tournament_id, game_index)
    REFERENCES public.wl_question_runs (attempt_id, tournament_id, game_index)
);

-- Game-total recomputation (scoring repair, results, recovery).
CREATE INDEX IF NOT EXISTS idx_wl_answers_game_user
  ON public.wl_answers (tournament_id, game_index, user_id);

CREATE TABLE IF NOT EXISTS public.wl_game_results (
  tournament_id uuid NOT NULL REFERENCES public.wl_tournaments(id) ON DELETE CASCADE,
  game_index integer NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id),
  score integer NOT NULL CHECK (score >= 0),
  time_ms_total bigint NOT NULL CHECK (time_ms_total >= 0),
  rank integer NOT NULL CHECK (rank > 0),
  advanced boolean NOT NULL,
  void_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tournament_id, game_index, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wl_game_results_rank
  ON public.wl_game_results (tournament_id, game_index, rank);

-- -----------------------------------------------------------------------------
-- Outbox
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.wl_events (
  tournament_id uuid NOT NULL REFERENCES public.wl_tournaments(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  type text NOT NULL CHECK (type IN (
    'phase', 'dispatch', 'clue_reveal', 'reveal', 'void', 'game_result',
    'final_result', 'cancellation'
  )),
  payload jsonb NOT NULL,
  redis_time_ms bigint NOT NULL,
  live_emitted_redis_ms bigint,
  visible_at_spec_ms bigint,
  claim_token uuid,
  claim_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  delivered_at timestamptz,
  aborted_at timestamptz,
  skipped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tournament_id, seq),
  -- Terminal state is exactly one of delivered / aborted / ops-skipped.
  CHECK (
    (delivered_at IS NOT NULL)::int
    + (aborted_at IS NOT NULL)::int
    + (skipped_at IS NOT NULL)::int <= 1
  )
);

-- The deliverer's claim scan: lowest non-terminal seq per tournament.
CREATE INDEX IF NOT EXISTS idx_wl_events_undelivered
  ON public.wl_events (tournament_id, seq)
  WHERE delivered_at IS NULL AND aborted_at IS NULL AND skipped_at IS NULL;

-- Spectator cursor scan: delivered public events becoming visible.
CREATE INDEX IF NOT EXISTS idx_wl_events_spec
  ON public.wl_events (tournament_id, visible_at_spec_ms)
  WHERE delivered_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Awards + audit
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.wl_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.wl_tournaments(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  final_rank integer NOT NULL,
  band text NOT NULL,
  prize_type text NOT NULL,
  prize_value text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'revoked')),
  fulfilled_at timestamptz,
  fulfilled_by text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (tournament_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.wl_award_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES public.wl_awards(id),
  actor_type text NOT NULL CHECK (actor_type IN ('admin', 'ops_token', 'system')),
  actor_id text NOT NULL,
  action text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- Awards: entitlement fields are immutable; only fulfillment state may change,
-- and deletes are rejected. The audit table is append-only.
CREATE OR REPLACE FUNCTION public.wl_awards_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wl_awards rows cannot be deleted';
  END IF;
  IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.final_rank IS DISTINCT FROM OLD.final_rank
     OR NEW.band IS DISTINCT FROM OLD.band
     OR NEW.prize_type IS DISTINCT FROM OLD.prize_type
     OR NEW.prize_value IS DISTINCT FROM OLD.prize_value
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'wl_awards entitlement fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wl_awards_guard ON public.wl_awards;
CREATE TRIGGER trg_wl_awards_guard
  BEFORE UPDATE OR DELETE ON public.wl_awards
  FOR EACH ROW EXECUTE FUNCTION public.wl_awards_guard();

CREATE OR REPLACE FUNCTION public.wl_award_actions_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wl_award_actions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wl_award_actions_append_only ON public.wl_award_actions;
CREATE TRIGGER trg_wl_award_actions_append_only
  BEFORE UPDATE OR DELETE ON public.wl_award_actions
  FOR EACH ROW EXECUTE FUNCTION public.wl_award_actions_append_only();

-- -----------------------------------------------------------------------------
-- Notifications: admit WL waves + recipient-level idempotency
-- -----------------------------------------------------------------------------

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'points_adjustment', 'season_award', 'announcement', 'friend_request',
    'weekend_league'
  ));

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS source_event_key text;

-- A notification wave (e.g. "check-in open") inserts one row per recipient
-- with ON CONFLICT DO NOTHING on this key — crash-resumable without duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_source_event
  ON public.notifications (user_id, source_event_key)
  WHERE source_event_key IS NOT NULL;

-- House updated_at maintenance (trigger_set_updated_at from the initial schema).
DROP TRIGGER IF EXISTS trg_wl_tournaments_set_updated_at ON public.wl_tournaments;
CREATE TRIGGER trg_wl_tournaments_set_updated_at
  BEFORE UPDATE ON public.wl_tournaments
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_wl_question_runs_set_updated_at ON public.wl_question_runs;
CREATE TRIGGER trg_wl_question_runs_set_updated_at
  BEFORE UPDATE ON public.wl_question_runs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Award audit lookups (fulfillment history per award).
CREATE INDEX IF NOT EXISTS idx_wl_award_actions_award
  ON public.wl_award_actions (award_id, created_at);

-- -----------------------------------------------------------------------------
-- RLS: deny-all (service role bypasses)
-- -----------------------------------------------------------------------------

ALTER TABLE public.wl_qp_awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wl_qp ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wl_tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wl_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wl_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wl_question_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wl_game_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wl_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wl_game_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wl_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wl_awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wl_award_actions ENABLE ROW LEVEL SECURITY;
