-- Football Grid: immutable reviewed content, authoritative 1v1 runtime,
-- moderation, settlement, and lifecycle isolation.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Durable match/lobby variant
-- ---------------------------------------------------------------------------

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS game_variant text DEFAULT 'friendly_possession';

-- PostgreSQL stores a constant ADD COLUMN default as table metadata rather
-- than rewriting every historical match. Drop the default immediately so the
-- rolling-deploy trigger below remains authoritative for legacy writers.
ALTER TABLE public.matches ALTER COLUMN game_variant DROP DEFAULT;

-- Rolling-deploy compatibility for legacy writers and test fixtures that do
-- not yet send the new discriminator. The database derives it once at insert;
-- runtime dispatch still treats the persisted value as authoritative and
-- fails closed for anything outside the explicit constraint below.
CREATE OR REPLACE FUNCTION public.set_match_game_variant_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.game_variant IS NULL THEN
    NEW.game_variant := CASE
      WHEN NEW.mode = 'auction' THEN 'auction'
      WHEN NEW.mode = 'ranked' THEN 'ranked_sim'
      WHEN NEW.state_payload->>'variant' = 'friendly_party_quiz' THEN 'friendly_party_quiz'
      WHEN NEW.state_payload->>'variant' = 'football_grid' THEN 'football_grid'
      ELSE 'friendly_possession'
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_match_game_variant_on_insert ON public.matches;
CREATE TRIGGER set_match_game_variant_on_insert
  BEFORE INSERT ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.set_match_game_variant_on_insert();

-- Called by the following non-transactional migration. Each iteration commits
-- independently, so historical ranked/auction/party rows never hold one large
-- lock set for the duration of the complete backfill.
CREATE OR REPLACE PROCEDURE public.football_grid_backfill_game_variants(batch_size integer DEFAULT 1000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count integer;
  has_remaining boolean;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id,
             CASE
               WHEN mode = 'auction' THEN 'auction'
               WHEN mode = 'ranked' THEN 'ranked_sim'
               WHEN state_payload->>'variant' = 'friendly_party_quiz' THEN 'friendly_party_quiz'
               WHEN state_payload->>'variant' = 'football_grid' THEN 'football_grid'
               ELSE 'friendly_possession'
             END AS desired_variant
        FROM public.matches
       WHERE game_variant IS DISTINCT FROM CASE
               WHEN mode = 'auction' THEN 'auction'
               WHEN mode = 'ranked' THEN 'ranked_sim'
               WHEN state_payload->>'variant' = 'friendly_party_quiz' THEN 'friendly_party_quiz'
               WHEN state_payload->>'variant' = 'football_grid' THEN 'football_grid'
               ELSE 'friendly_possession'
             END
       ORDER BY id
       LIMIT GREATEST(batch_size, 1)
       FOR UPDATE SKIP LOCKED
    )
    UPDATE public.matches m
       SET game_variant = batch.desired_variant
      FROM batch
     WHERE m.id = batch.id;
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    COMMIT;
    IF updated_count = 0 THEN
      SELECT EXISTS (
        SELECT 1
          FROM public.matches
         WHERE game_variant IS DISTINCT FROM CASE
                 WHEN mode = 'auction' THEN 'auction'
                 WHEN mode = 'ranked' THEN 'ranked_sim'
                 WHEN state_payload->>'variant' = 'friendly_party_quiz' THEN 'friendly_party_quiz'
                 WHEN state_payload->>'variant' = 'football_grid' THEN 'football_grid'
                 ELSE 'friendly_possession'
               END
      ) INTO has_remaining;
      EXIT WHEN NOT has_remaining;
      -- A zero-row SKIP LOCKED batch can mean the remaining candidates are
      -- temporarily locked, not that the backfill is complete.
      PERFORM pg_sleep(0.25);
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON PROCEDURE public.football_grid_backfill_game_variants(integer) FROM PUBLIC;

ALTER TABLE public.matches
  DROP CONSTRAINT IF EXISTS matches_game_variant_check;

ALTER TABLE public.matches
  ADD CONSTRAINT matches_game_variant_check CHECK (
    game_variant IN (
      'friendly_possession',
      'friendly_party_quiz',
      'ranked_sim',
      'auction',
      'football_grid'
    )
  ) NOT VALID;

ALTER TABLE public.matches
  ADD CONSTRAINT matches_game_variant_not_null CHECK (game_variant IS NOT NULL) NOT VALID;

ALTER TABLE public.lobbies
  ADD CONSTRAINT lobbies_game_mode_check_v2 CHECK (
    game_mode IN (
      'friendly_possession',
      'friendly_party_quiz',
      'auction',
      'ranked_sim',
      'football_grid'
    )
  ) NOT VALID;

ALTER TABLE public.matches
  ADD CONSTRAINT matches_mode_game_variant_check CHECK (
    (mode = 'auction' AND game_variant = 'auction')
    OR (mode = 'ranked' AND game_variant = 'ranked_sim')
    OR (
      mode = 'friendly'
      AND game_variant IN ('friendly_possession', 'friendly_party_quiz', 'football_grid')
    )
  ) NOT VALID;

-- ---------------------------------------------------------------------------
-- Content releases and provenance
-- ---------------------------------------------------------------------------

CREATE TABLE public.football_grid_data_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL,
  provider_name text NOT NULL,
  dataset_version text NOT NULL,
  permitted_use text NOT NULL,
  database_rights_status text NOT NULL CHECK (
    database_rights_status IN ('pending', 'approved', 'rejected')
  ),
  attribution_requirements text,
  retention_requirements text,
  approval_owner text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    database_rights_status <> 'approved'
    OR (approval_owner IS NOT NULL AND approved_at IS NOT NULL)
  ),
  UNIQUE (source_key, dataset_version)
);

CREATE TABLE public.football_grid_content_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'feasibility', 'published', 'retired')
  ),
  relationship_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(relationship_snapshot) = 'object'
  ),
  alias_version integer NOT NULL CHECK (alias_version > 0),
  resolver_policy_version integer NOT NULL CHECK (resolver_policy_version > 0),
  manifest_checksum text NOT NULL UNIQUE CHECK (length(manifest_checksum) BETWEEN 32 AND 128),
  approved_by text,
  approved_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    status <> 'published'
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE TABLE public.football_grid_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES public.football_grid_content_releases(id) ON DELETE RESTRICT,
  criterion_key text NOT NULL,
  family text NOT NULL CHECK (
    family IN ('club', 'country', 'league', 'manager', 'teammate', 'trophy_award', 'wildcard')
  ),
  subtype text NOT NULL,
  label_en text NOT NULL CHECK (length(label_en) BETWEEN 1 AND 160),
  label_ka text NOT NULL CHECK (length(label_ka) BETWEEN 1 AND 160),
  asset_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  difficulty text NOT NULL CHECK (difficulty IN ('easy', 'normal', 'hard')),
  familiarity_score numeric(6,3) NOT NULL CHECK (familiarity_score BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, criterion_key),
  UNIQUE (id, release_id)
);

CREATE TABLE public.football_grid_criterion_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES public.football_grid_content_releases(id) ON DELETE RESTRICT,
  criterion_id uuid NOT NULL REFERENCES public.football_grid_criteria(id) ON DELETE RESTRICT,
  football_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE RESTRICT,
  relationship_subtype text NOT NULL,
  effective_from date,
  effective_to date,
  verified_by text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (criterion_id, release_id)
    REFERENCES public.football_grid_criteria(id, release_id) ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  UNIQUE (criterion_id, football_player_id)
);

CREATE INDEX football_grid_memberships_player_idx
  ON public.football_grid_criterion_memberships (football_player_id, criterion_id);

CREATE TABLE public.football_grid_membership_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES public.football_grid_criterion_memberships(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES public.football_grid_data_sources(id) ON DELETE RESTRICT,
  source_locator text NOT NULL,
  captured_fact text NOT NULL,
  effective_from date,
  effective_to date,
  rights_class text NOT NULL,
  evidence_checksum text NOT NULL CHECK (length(evidence_checksum) BETWEEN 32 AND 128),
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, source_id, evidence_checksum)
);

CREATE TABLE public.football_grid_player_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES public.football_grid_content_releases(id) ON DELETE RESTRICT,
  football_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE RESTRICT,
  alias text NOT NULL CHECK (length(alias) BETWEEN 1 AND 160),
  normalized_alias text NOT NULL CHECK (length(normalized_alias) BETWEEN 1 AND 160),
  locale text NOT NULL CHECK (locale IN ('en', 'ka', 'translit')),
  alias_type text NOT NULL CHECK (
    alias_type IN (
      'full_name', 'given_name', 'family_name', 'reordered', 'compound_surname',
      'mononym', 'nickname', 'accentless', 'georgian', 'transliteration',
      'reviewed_misspelling'
    )
  ),
  acceptance_policy text NOT NULL CHECK (
    acceptance_policy IN ('exact', 'unique_only', 'safe_typo')
  ),
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, football_player_id, normalized_alias, locale, alias_type),
  UNIQUE (id, football_player_id, release_id)
);

CREATE INDEX football_grid_alias_lookup_idx
  ON public.football_grid_player_aliases (release_id, normalized_alias);

CREATE TABLE public.football_grid_boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES public.football_grid_content_releases(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  row_criteria uuid[] NOT NULL,
  column_criteria uuid[] NOT NULL,
  difficulty text NOT NULL CHECK (difficulty IN ('easy', 'normal', 'hard')),
  familiarity_score numeric(6,3) NOT NULL CHECK (familiarity_score BETWEEN 0 AND 100),
  canonical_checksum text NOT NULL CHECK (length(canonical_checksum) BETWEEN 32 AND 128),
  approved_by text NOT NULL,
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(row_criteria) = 3),
  CHECK (cardinality(column_criteria) = 3),
  UNIQUE (release_id, canonical_checksum),
  UNIQUE (id, release_id)
);

CREATE INDEX football_grid_boards_release_difficulty_idx
  ON public.football_grid_boards (release_id, difficulty, published_at);

CREATE TABLE public.football_grid_board_answers (
  board_id uuid NOT NULL REFERENCES public.football_grid_boards(id) ON DELETE RESTRICT,
  release_id uuid NOT NULL REFERENCES public.football_grid_content_releases(id) ON DELETE RESTRICT,
  cell_index smallint NOT NULL CHECK (cell_index BETWEEN 0 AND 8),
  football_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE RESTRICT,
  player_name_en text,
  player_name_ka text,
  image_asset_key text,
  recognizable_rank integer CHECK (recognizable_rank IS NULL OR recognizable_rank > 0),
  is_sample boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, cell_index, football_player_id),
  FOREIGN KEY (board_id, release_id)
    REFERENCES public.football_grid_boards(id, release_id) ON DELETE RESTRICT
);

CREATE INDEX football_grid_board_answers_player_idx
  ON public.football_grid_board_answers (board_id, football_player_id);

CREATE TABLE public.football_grid_content_quarantines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES public.football_grid_content_releases(id) ON DELETE RESTRICT,
  board_id uuid REFERENCES public.football_grid_boards(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('disable', 'enable')),
  reason text NOT NULL,
  actor text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (action = 'disable' OR expires_at IS NULL),
  FOREIGN KEY (board_id, release_id)
    REFERENCES public.football_grid_boards(id, release_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.football_grid_validate_board_criteria()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  matching_count integer;
BEGIN
  IF cardinality(ARRAY(SELECT DISTINCT unnest(NEW.row_criteria || NEW.column_criteria))) <> 6 THEN
    RAISE EXCEPTION 'football grid board criteria must be six unique ids';
  END IF;
  SELECT count(*) INTO matching_count
    FROM public.football_grid_criteria c
   WHERE c.release_id = NEW.release_id
     AND c.id = ANY(NEW.row_criteria || NEW.column_criteria);
  IF matching_count <> 6 THEN
    RAISE EXCEPTION 'football grid board criteria must belong to its release';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER football_grid_board_criteria_valid
  BEFORE INSERT ON public.football_grid_boards
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_validate_board_criteria();

CREATE INDEX football_grid_quarantines_lookup_idx
  ON public.football_grid_content_quarantines (release_id, board_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Runtime state
-- ---------------------------------------------------------------------------

CREATE TABLE public.football_grid_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin text NOT NULL CHECK (origin IN ('random', 'challenge', 'private', 'public', 'code')),
  lobby_id uuid REFERENCES public.lobbies(id) ON DELETE SET NULL,
  current_match_id uuid REFERENCES public.matches(id) ON DELETE SET NULL,
  rematch_index integer NOT NULL DEFAULT 0 CHECK (rematch_index >= 0),
  next_opener_seat smallint NOT NULL CHECK (next_opener_seat IN (1, 2)),
  state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rematch_pending', 'closed')),
  rematch_expires_at timestamptz,
  next_pairing_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.football_grid_matches (
  match_id uuid PRIMARY KEY REFERENCES public.matches(id) ON DELETE CASCADE,
  pairing_token uuid NOT NULL UNIQUE,
  board_id uuid NOT NULL REFERENCES public.football_grid_boards(id) ON DELETE RESTRICT,
  content_release_id uuid NOT NULL REFERENCES public.football_grid_content_releases(id) ON DELETE RESTRICT,
  alias_release_id uuid NOT NULL REFERENCES public.football_grid_content_releases(id) ON DELETE RESTRICT,
  resolver_policy_version integer NOT NULL CHECK (resolver_policy_version > 0),
  board_checksum text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('handoff', 'loading', 'countdown', 'active', 'paused', 'completed', 'forfeited', 'cancelled')
  ),
  phase text NOT NULL CHECK (
    phase IN ('handoff', 'loading', 'countdown', 'turn', 'paused', 'service_interruption', 'terminal')
  ),
  origin text NOT NULL CHECK (origin IN ('random', 'challenge', 'private', 'public', 'code')),
  series_id uuid REFERENCES public.football_grid_series(id) ON DELETE SET NULL,
  rematch_of_match_id uuid UNIQUE REFERENCES public.matches(id) ON DELETE SET NULL,
  rematch_index integer NOT NULL DEFAULT 0 CHECK (rematch_index >= 0),
  opener_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  current_player_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  winner_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  turn_number integer NOT NULL DEFAULT 0 CHECK (turn_number >= 0),
  state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  last_event_sequence bigint NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
  pending_command_id uuid,
  phase_deadline_at timestamptz,
  turn_deadline_at timestamptz,
  turn_remaining_ms integer CHECK (turn_remaining_ms IS NULL OR turn_remaining_ms >= 0),
  paused_at timestamptz,
  paused_from_phase text CHECK (paused_from_phase IN ('countdown', 'turn')),
  reconnect_deadline_at timestamptz,
  bot_action_deadline_at timestamptz,
  wrong_answer_visibility boolean NOT NULL DEFAULT false,
  reward_schedule_version integer NOT NULL DEFAULT 1 CHECK (reward_schedule_version > 0),
  bot_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  bot_reservation_fence bigint,
  bot_rp integer,
  bot_tier text,
  bot_model_version integer,
  bot_config_version integer,
  bot_rng_seed bigint,
  completion_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  FOREIGN KEY (board_id, content_release_id)
    REFERENCES public.football_grid_boards(id, release_id) ON DELETE RESTRICT
);

CREATE INDEX football_grid_matches_deadline_idx
  ON public.football_grid_matches (phase, phase_deadline_at)
  WHERE phase_deadline_at IS NOT NULL AND status NOT IN ('completed', 'forfeited', 'cancelled');

CREATE INDEX football_grid_matches_turn_deadline_idx
  ON public.football_grid_matches (turn_deadline_at)
  WHERE status = 'active' AND phase = 'turn';

CREATE TABLE public.football_grid_participants (
  match_id uuid NOT NULL REFERENCES public.football_grid_matches(match_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  seat smallint NOT NULL CHECK (seat IN (1, 2)),
  is_bot boolean NOT NULL DEFAULT false,
  handoff_ack_at timestamptz,
  ready_at timestamptz,
  ready_command_id uuid,
  presence_generation bigint NOT NULL DEFAULT 0 CHECK (presence_generation >= 0),
  absent_since timestamptz,
  pause_budget_remaining_ms integer NOT NULL DEFAULT 60000 CHECK (pause_budget_remaining_ms >= 0),
  no_action_timeout_count smallint NOT NULL DEFAULT 0 CHECK (no_action_timeout_count BETWEEN 0 AND 3),
  reward_eligibility_type text NOT NULL DEFAULT 'human' CHECK (
    reward_eligibility_type IN ('human', 'bot', 'none')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id),
  UNIQUE (match_id, seat)
);

ALTER TABLE public.football_grid_matches
  ADD CONSTRAINT football_grid_opener_participant_fk
  FOREIGN KEY (match_id, opener_user_id)
  REFERENCES public.football_grid_participants(match_id, user_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.football_grid_matches
  ADD CONSTRAINT football_grid_current_participant_fk
  FOREIGN KEY (match_id, current_player_user_id)
  REFERENCES public.football_grid_participants(match_id, user_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.football_grid_matches
  ADD CONSTRAINT football_grid_winner_participant_fk
  FOREIGN KEY (match_id, winner_user_id)
  REFERENCES public.football_grid_participants(match_id, user_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.football_grid_command_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES public.football_grid_matches(match_id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  expected_state_version integer NOT NULL CHECK (expected_state_version >= 0),
  turn_number integer NOT NULL CHECK (turn_number >= 0),
  command_type text NOT NULL CHECK (command_type IN ('answer', 'pass', 'forfeit')),
  cell_index smallint CHECK (cell_index BETWEEN 0 AND 8),
  locale text CHECK (locale IN ('en', 'ka')),
  submitted_text text CHECK (submitted_text IS NULL OR length(submitted_text) BETWEEN 1 AND 160),
  payload_hash text NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')
  ),
  processing_fence uuid,
  processing_lease_until timestamptz,
  retry_count smallint NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 3),
  next_retry_at timestamptz,
  last_error text,
  completed_at timestamptz,
  result_code text,
  result_payload jsonb CHECK (result_payload IS NULL OR jsonb_typeof(result_payload) = 'object'),
  UNIQUE (match_id, actor_user_id, command_id),
  FOREIGN KEY (match_id, actor_user_id)
    REFERENCES public.football_grid_participants(match_id, user_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX football_grid_one_pending_command_idx
  ON public.football_grid_command_inbox (match_id, actor_user_id, turn_number, expected_state_version)
  WHERE status IN ('pending', 'processing');

CREATE INDEX football_grid_command_recovery_idx
  ON public.football_grid_command_inbox (status, processing_lease_until, next_retry_at);

ALTER TABLE public.football_grid_matches
  ADD CONSTRAINT football_grid_matches_pending_command_fk
  FOREIGN KEY (pending_command_id)
  REFERENCES public.football_grid_command_inbox(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.football_grid_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL UNIQUE REFERENCES public.football_grid_command_inbox(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES public.football_grid_matches(match_id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  turn_number integer NOT NULL,
  cell_index smallint CHECK (cell_index BETWEEN 0 AND 8),
  locale text CHECK (locale IN ('en', 'ka')),
  submitted_text text,
  normalized_text text,
  outcome text NOT NULL CHECK (
    outcome IN ('correct', 'wrong', 'ambiguous', 'already_used', 'pass', 'late', 'stale', 'internal_error')
  ),
  resolved_player_id uuid REFERENCES public.football_players(id) ON DELETE RESTRICT,
  admitted_at timestamptz NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (match_id, actor_user_id)
    REFERENCES public.football_grid_participants(match_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX football_grid_attempts_retention_idx
  ON public.football_grid_attempts (resolved_at);

CREATE TABLE public.football_grid_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES public.football_grid_matches(match_id) ON DELETE CASCADE,
  cell_index smallint NOT NULL CHECK (cell_index BETWEEN 0 AND 8),
  football_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE RESTRICT,
  claimant_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  turn_number integer NOT NULL CHECK (turn_number >= 0),
  accepted_alias_id uuid REFERENCES public.football_grid_player_aliases(id) ON DELETE RESTRICT,
  accepted_alias_release_id uuid REFERENCES public.football_grid_content_releases(id) ON DELETE RESTRICT,
  submitted_locale text NOT NULL CHECK (submitted_locale IN ('en', 'ka')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, cell_index),
  UNIQUE (match_id, football_player_id),
  CHECK ((accepted_alias_id IS NULL) = (accepted_alias_release_id IS NULL)),
  FOREIGN KEY (match_id, claimant_user_id)
    REFERENCES public.football_grid_participants(match_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (accepted_alias_id, football_player_id, accepted_alias_release_id)
    REFERENCES public.football_grid_player_aliases(id, football_player_id, release_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.football_grid_validate_claim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  persisted_turn integer;
  next_actor uuid;
  persisted_phase text;
BEGIN
  SELECT gm.turn_number, gm.current_player_user_id, gm.phase
    INTO persisted_turn, next_actor, persisted_phase
    FROM public.football_grid_matches gm
   WHERE gm.match_id = NEW.match_id;
  IF persisted_turn IS NULL OR (
    (persisted_phase = 'terminal' AND NEW.turn_number <> persisted_turn)
    OR (persisted_phase <> 'terminal' AND NEW.turn_number <> persisted_turn - 1)
  ) THEN
    RAISE EXCEPTION 'football grid claim has an invalid turn';
  END IF;
  IF next_actor IS NOT NULL AND next_actor = NEW.claimant_user_id THEN
    RAISE EXCEPTION 'football grid claim actor does not own the resolved turn';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.football_grid_matches gm
      JOIN public.football_grid_board_answers a
        ON a.board_id = gm.board_id
       AND a.cell_index = NEW.cell_index
       AND a.football_player_id = NEW.football_player_id
     WHERE gm.match_id = NEW.match_id
  ) THEN
    RAISE EXCEPTION 'football grid claim is not valid for the pinned board cell';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER football_grid_claim_valid
  BEFORE INSERT ON public.football_grid_claims
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_validate_claim();

CREATE TABLE public.football_grid_events (
  match_id uuid NOT NULL REFERENCES public.football_grid_matches(match_id) ON DELETE CASCADE,
  event_sequence bigint NOT NULL CHECK (event_sequence > 0),
  state_version integer NOT NULL CHECK (state_version >= 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, event_sequence)
);

CREATE OR REPLACE FUNCTION public.football_grid_validate_event_sequence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  runtime_match public.football_grid_matches%ROWTYPE;
BEGIN
  SELECT * INTO runtime_match
    FROM public.football_grid_matches
   WHERE match_id = NEW.match_id;

  IF NOT FOUND
     OR NEW.event_sequence <> runtime_match.last_event_sequence
     OR NEW.state_version <> runtime_match.state_version THEN
    RAISE EXCEPTION 'football_grid_event_sequence_mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER football_grid_event_sequence_valid
  BEFORE INSERT ON public.football_grid_events
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_validate_event_sequence();

CREATE TABLE public.football_grid_board_exposures (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  board_id uuid NOT NULL REFERENCES public.football_grid_boards(id) ON DELETE RESTRICT,
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  played_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, match_id)
);

CREATE INDEX football_grid_exposures_rotation_idx
  ON public.football_grid_board_exposures (user_id, played_at DESC, board_id);

CREATE TABLE public.football_grid_pairings (
  pairing_token uuid PRIMARY KEY,
  search_a_id uuid NOT NULL,
  search_b_id uuid,
  user_a_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  user_b_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  opponent_type text NOT NULL CHECK (opponent_type IN ('human', 'bot')),
  status text NOT NULL CHECK (status IN ('claimed', 'matched', 'cancelled', 'failed')),
  match_id uuid UNIQUE REFERENCES public.matches(id) ON DELETE SET NULL,
  failure_reason text,
  search_a_snapshot jsonb CHECK (search_a_snapshot IS NULL OR jsonb_typeof(search_a_snapshot) = 'object'),
  search_b_snapshot jsonb CHECK (search_b_snapshot IS NULL OR jsonb_typeof(search_b_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_a_id <> user_b_id)
);

CREATE INDEX football_grid_pairings_recovery_idx
  ON public.football_grid_pairings (status, updated_at)
  WHERE status = 'claimed';

CREATE TABLE public.football_grid_series_acceptances (
  series_id uuid NOT NULL REFERENCES public.football_grid_series(id) ON DELETE CASCADE,
  rematch_index integer NOT NULL CHECK (rematch_index > 0),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  expected_series_version integer NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accept', 'decline')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, rematch_index, user_id),
  UNIQUE (series_id, rematch_index, command_id)
);

-- ---------------------------------------------------------------------------
-- Settlement, economy controls, and moderation
-- ---------------------------------------------------------------------------

CREATE TABLE public.football_grid_settlement_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  terminal_state_version integer NOT NULL,
  reward_schedule_version integer NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'completed', 'failed')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (match_id, terminal_state_version)
);

CREATE INDEX football_grid_settlement_pending_idx
  ON public.football_grid_settlement_outbox (status, next_retry_at, created_at);

CREATE TABLE public.football_grid_result_deliveries (
  match_id uuid NOT NULL REFERENCES public.football_grid_matches(match_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  terminal_state_version integer NOT NULL CHECK (terminal_state_version >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'awaiting_ack', 'delivered')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ack_token uuid,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  processing_lease_until timestamptz,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id),
  CHECK (
    (status = 'pending' AND ack_token IS NULL)
    OR (status IN ('processing', 'awaiting_ack', 'delivered') AND ack_token IS NOT NULL)
  ),
  FOREIGN KEY (match_id, user_id)
    REFERENCES public.football_grid_participants(match_id, user_id) ON DELETE CASCADE
);

CREATE INDEX football_grid_result_deliveries_pending_idx
  ON public.football_grid_result_deliveries (status, next_attempt_at, match_id, user_id)
  WHERE status <> 'delivered';

CREATE TABLE public.football_grid_reward_budgets (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  last_evaluated_at timestamptz,
  last_reconciled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.football_grid_reward_risk_decisions (
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  evaluator_version integer NOT NULL DEFAULT 1 CHECK (evaluator_version > 0),
  decision text NOT NULL CHECK (decision IN ('clear', 'held', 'ineligible')),
  reason text NOT NULL,
  signals jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(signals) = 'object'),
  source text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id, evaluator_version),
  FOREIGN KEY (match_id, user_id)
    REFERENCES public.football_grid_participants(match_id, user_id) ON DELETE CASCADE
);

CREATE TABLE public.football_grid_reward_risk_observations (
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_hash text,
  network_hash text,
  source text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id),
  CHECK (device_hash IS NOT NULL OR network_hash IS NOT NULL),
  FOREIGN KEY (match_id, user_id)
    REFERENCES public.football_grid_participants(match_id, user_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.football_grid_reward_risk_observations IS
  'Pseudonymous device/network reward-risk signals; runtime retention is 90 days.';

CREATE INDEX football_grid_reward_risk_observations_identity_idx
  ON public.football_grid_reward_risk_observations (device_hash, network_hash, observed_at DESC);

CREATE INDEX football_grid_reward_risk_observations_retention_idx
  ON public.football_grid_reward_risk_observations (observed_at);

CREATE TABLE public.football_grid_reward_eligibility (
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  evaluator_version integer NOT NULL,
  opponent_type text NOT NULL CHECK (opponent_type IN ('human', 'bot')),
  origin text NOT NULL,
  participation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(participation) = 'object'),
  repeated_pair_count integer NOT NULL DEFAULT 0,
  rolling_coin_total integer NOT NULL DEFAULT 0,
  rolling_bot_matches integer NOT NULL DEFAULT 0,
  risk_decision text CHECK (risk_decision IN ('clear', 'held', 'ineligible')),
  risk_signals jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(risk_signals) = 'object'),
  decision text NOT NULL CHECK (decision IN ('eligible', 'ineligible', 'held')),
  reason text NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id, evaluator_version),
  FOREIGN KEY (match_id, user_id)
    REFERENCES public.football_grid_participants(match_id, user_id) ON DELETE CASCADE
);

CREATE TABLE public.football_grid_coin_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reward_type text NOT NULL DEFAULT 'football_grid_match',
  amount integer NOT NULL CHECK (amount >= 0),
  status text NOT NULL CHECK (status IN ('committed', 'held', 'reversed')),
  eligibility_reason text NOT NULL,
  reversal_of uuid REFERENCES public.football_grid_coin_events(id) ON DELETE RESTRICT,
  credited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, user_id, reward_type),
  FOREIGN KEY (match_id, user_id)
    REFERENCES public.football_grid_participants(match_id, user_id) ON DELETE CASCADE
);

CREATE INDEX football_grid_coin_events_budget_idx
  ON public.football_grid_coin_events (user_id, created_at DESC)
  WHERE status IN ('committed', 'held');

CREATE TABLE public.football_grid_coin_event_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_event_id uuid NOT NULL REFERENCES public.football_grid_coin_events(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('release', 'reverse')),
  amount integer NOT NULL CHECK (amount >= 0),
  reason text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.football_grid_missing_answer_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.football_grid_attempts(id) ON DELETE RESTRICT,
  reporting_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'accepted', 'rejected', 'duplicate', 'closed')
  ),
  reviewer_notes text,
  reviewed_by text,
  reviewed_at timestamptz,
  decision_release_id uuid REFERENCES public.football_grid_content_releases(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, reporting_user_id),
  CHECK (status <> 'accepted' OR decision_release_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Append-only publishing controls and private access
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.football_grid_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'published football grid content is append-only';
END;
$$;

CREATE OR REPLACE FUNCTION public.football_grid_protect_published_release()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'published' AND TG_OP = 'UPDATE'
     AND NEW.status = 'retired'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('published', 'retired') THEN
    RAISE EXCEPTION 'published football grid release is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'football grid releases cannot be deleted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.football_grid_protect_approved_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.database_rights_status = 'approved' THEN
    RAISE EXCEPTION 'approved football grid provenance is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'football grid provenance cannot be deleted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER football_grid_source_immutable
  BEFORE UPDATE OR DELETE ON public.football_grid_data_sources
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_protect_approved_source();

CREATE TRIGGER football_grid_release_immutable
  BEFORE UPDATE OR DELETE ON public.football_grid_content_releases
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_protect_published_release();

CREATE TRIGGER football_grid_criteria_immutable
  BEFORE UPDATE OR DELETE ON public.football_grid_criteria
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_reject_mutation();
CREATE TRIGGER football_grid_memberships_immutable
  BEFORE UPDATE OR DELETE ON public.football_grid_criterion_memberships
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_reject_mutation();
CREATE TRIGGER football_grid_evidence_immutable
  BEFORE UPDATE OR DELETE ON public.football_grid_membership_evidence
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_reject_mutation();
CREATE TRIGGER football_grid_aliases_immutable
  BEFORE UPDATE OR DELETE ON public.football_grid_player_aliases
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_reject_mutation();
CREATE TRIGGER football_grid_boards_immutable
  BEFORE UPDATE OR DELETE ON public.football_grid_boards
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_reject_mutation();
CREATE TRIGGER football_grid_answers_immutable
  BEFORE UPDATE OR DELETE ON public.football_grid_board_answers
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_reject_mutation();
CREATE TRIGGER football_grid_quarantine_append_only
  BEFORE UPDATE OR DELETE ON public.football_grid_content_quarantines
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_reject_mutation();

ALTER TABLE public.football_grid_data_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_content_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_criterion_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_membership_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_player_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_board_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_content_quarantines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_command_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_board_exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_series_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_pairings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_settlement_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_result_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_reward_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_reward_risk_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_reward_risk_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_reward_eligibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_coin_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_coin_event_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_missing_answer_reports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.football_grid_data_sources,
  public.football_grid_content_releases,
  public.football_grid_criteria,
  public.football_grid_criterion_memberships,
  public.football_grid_membership_evidence,
  public.football_grid_player_aliases,
  public.football_grid_boards,
  public.football_grid_board_answers,
  public.football_grid_content_quarantines,
  public.football_grid_matches,
  public.football_grid_participants,
  public.football_grid_command_inbox,
  public.football_grid_attempts,
  public.football_grid_claims,
  public.football_grid_events,
  public.football_grid_board_exposures,
  public.football_grid_series,
  public.football_grid_series_acceptances,
  public.football_grid_pairings,
  public.football_grid_settlement_outbox,
  public.football_grid_result_deliveries,
  public.football_grid_reward_budgets,
  public.football_grid_reward_risk_decisions,
  public.football_grid_reward_risk_observations,
  public.football_grid_reward_eligibility,
  public.football_grid_coin_events,
  public.football_grid_coin_event_audit,
  public.football_grid_missing_answer_reports
FROM anon, authenticated;
