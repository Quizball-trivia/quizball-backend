-- Day Builder, second game (HQ, straight to prod): Último.
-- A day there is five closed lists ("Clubs Diego Simeone played for or managed") and the player names their members
-- against a clock. A round of the builder is one list: agents choose it, write every member with the pages behind
-- them, another model family rebuilds the list from the web and checks it is complete, a third translates, and the
-- translations are checked. The backend puts five finished lists (two easy, two medium, one hard) together into the
-- next day and stores it through the game's own seed.

ALTER TABLE harness.day_rounds DROP CONSTRAINT IF EXISTS day_rounds_game_check;
ALTER TABLE harness.day_rounds DROP CONSTRAINT IF EXISTS harness_day_rounds_game;
ALTER TABLE harness.day_rounds ADD CONSTRAINT harness_day_rounds_game CHECK (game IN ('pistas', 'ultimo'));

INSERT INTO harness.policies (key, value, note) VALUES
  ('days.ultimo.ahead', '21'::jsonb, 'Último: how many days after today should already be stored. The Day Builder works until this many are.'),
  ('days.ultimo.max_open_rounds', '30'::jsonb, 'Último: the most lists that may be on their way (planned to ready) at one time.'),
  -- Starts off, like every game: the first lists are read by a person before any day is stored from them.
  ('days.ultimo.store', 'false'::jsonb, 'Último: whether finished lists are put together into days and stored for players. Off = lists are made and wait.')
ON CONFLICT (key) DO NOTHING;

-- Finishing a round goes before starting one. Every step used to queue the next at the same place in line as a new
-- round's first step, so a burst of new rounds held finished ones back from their last check. The later the step,
-- the earlier its job is taken (0 is first, 9 last).
CREATE OR REPLACE FUNCTION harness.round_step_done(p_job uuid, p_token uuid, p_body jsonb, p_note text, p_drop boolean, p_next_agent text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  j harness.jobs;
  was text;
  becomes text;
  next_kind text;
  next_priority integer;
BEGIN
  SELECT * INTO j FROM harness.jobs WHERE id = p_job AND status = 'running' AND lease_token = p_token FOR UPDATE;
  IF NOT FOUND OR j.day_round_id IS NULL THEN RETURN false; END IF;
  IF j.kind = 'round_write' THEN was := 'planned'; becomes := 'written'; next_kind := 'round_check'; next_priority := 2;
  ELSIF j.kind = 'round_check' THEN was := 'written'; becomes := 'checked'; next_kind := 'round_localize'; next_priority := 2;
  ELSIF j.kind = 'round_localize' THEN was := 'checked'; becomes := 'localized'; next_kind := 'round_locale_check'; next_priority := 1;
  ELSIF j.kind = 'round_locale_check' THEN was := 'localized'; becomes := 'ready'; next_kind := NULL;
  ELSE RETURN false;
  END IF;
  IF p_drop THEN
    UPDATE harness.day_rounds SET status = 'dropped', note = left(coalesce(p_note, 'dropped'), 1000), updated_at = now()
     WHERE id = j.day_round_id AND status = was;
    RETURN FOUND;
  END IF;
  IF jsonb_typeof(p_body) <> 'object' THEN RETURN false; END IF;
  UPDATE harness.day_rounds
     -- Each step adds what it has to say to what the steps before it noted (what each checker changed).
     SET status = becomes, updated_at = now(), note = nullif(left(concat_ws('; ', note, nullif(btrim(coalesce(p_note, '')), '')), 1000), ''),
         draft = CASE WHEN j.kind = 'round_write' THEN p_body ELSE draft END,
         checked = CASE WHEN j.kind = 'round_check' THEN p_body ELSE checked END,
         localized = CASE WHEN j.kind IN ('round_localize', 'round_locale_check') THEN p_body ELSE localized END
   WHERE id = j.day_round_id AND status = was;
  IF NOT FOUND THEN RETURN false; END IF;
  IF next_kind IS NOT NULL AND p_next_agent IS NOT NULL THEN
    INSERT INTO harness.jobs (kind, agent_slug, day_round_id, priority) VALUES (next_kind, p_next_agent, j.day_round_id, next_priority);
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION harness.round_step_done(uuid, uuid, jsonb, text, boolean, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.round_step_done(uuid, uuid, jsonb, text, boolean, text) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
