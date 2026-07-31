-- Append-only forensic log of free-text clue ("who am I") guess evaluations.
--
-- WHY: players report correct answers being marked WRONG (25+ rejections from a
-- single reporter on famous players). The matcher logic reviewed as correct and
-- the payload reviewed as correct, so the root cause is unconfirmed — and it
-- stays unconfirmed because nothing persists what the player actually typed.
-- The existing debug logs only carry answerHash/answerLength
-- (possession-debug-logging.ts), which cannot be reversed into a guess, and
-- match_answers stores only the boolean verdict. This table closes that gap by
-- recording the raw guess, the normalized form the matcher compared, the answer
-- set it compared against, and which rule matched or failed.
--
-- Retention-friendly by design: created_at is indexed so a future retention job
-- can delete by age with an index scan. No PII beyond the free text a player
-- types as a guess (no email/IP/device). Rows are never updated — insert-only.

CREATE TABLE IF NOT EXISTS public.clue_guess_evaluations (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),

  match_id      uuid        NOT NULL,
  user_id       uuid        NOT NULL,
  q_index       integer     NOT NULL,
  question_id   uuid,

  -- What the player typed, plus the normalized form normalizeAnswer() produced
  -- and actually compared. Both are needed: a normalization bug is invisible if
  -- only one side is stored.
  raw_guess         text    NOT NULL,
  normalized_guess  text    NOT NULL,

  -- The full candidate set the matcher compared against (accepted_answers plus
  -- the localized display answers the handler appends), stored raw and
  -- normalized. Answer sets for this question type are small (a player name and
  -- its variants), so inlining them beats a hash/reference: the whole point is
  -- to see the exact set at evaluation time, which later content edits would
  -- otherwise destroy.
  accepted_answers            jsonb   NOT NULL DEFAULT '[]'::jsonb,
  normalized_accepted_answers jsonb   NOT NULL DEFAULT '[]'::jsonb,
  accepted_answers_count      integer NOT NULL DEFAULT 0,

  -- Verdict as returned to the player, and the diagnosis of how it was reached.
  -- match_rule: exact | wholeWord | alias | typo on accept; NULL on reject.
  -- reject_reason: why nothing matched (empty_normalized_guess,
  -- below_typo_min_length, no_rule_matched, give_up, empty_answer_set).
  is_correct     boolean NOT NULL,
  give_up        boolean NOT NULL DEFAULT false,
  match_rule     text,
  match_distance integer,
  reject_reason  text,
  -- Per-candidate detail: closest rule considered and edit distance for each
  -- accepted answer. This is what turns "no_rule_matched" into an actionable
  -- diagnosis (e.g. a near-miss at distance 3 vs a threshold of 2).
  candidate_detail jsonb NOT NULL DEFAULT '[]'::jsonb,

  time_ms    integer,
  clue_index integer,

  -- Harness/bot traffic submits junk guesses by design (game-regression client)
  -- and staging runs 1,000 synthetic bots. Analysis MUST be able to exclude
  -- them, so the flag is stored on the row rather than joined at read time
  -- (users.is_ai can be flipped or the row cleaned up by the AI reaper).
  is_ai boolean NOT NULL DEFAULT false,

  -- 'sampled' marks accepts kept under the accept sampling rate; rejects are
  -- always 'full'. Lets analysis avoid mistaking sampling for a shift in the
  -- accept/reject ratio.
  capture_mode text NOT NULL DEFAULT 'full'
);

-- Primary forensic read path: recent rejects for a question, or for a user.
CREATE INDEX IF NOT EXISTS clue_guess_evaluations_question_created_idx
  ON public.clue_guess_evaluations (question_id, created_at DESC);

CREATE INDEX IF NOT EXISTS clue_guess_evaluations_user_created_idx
  ON public.clue_guess_evaluations (user_id, created_at DESC);

-- Retention/age scans and the "recent rejects across everything" sweep. Partial
-- on rejects + real players: that is the population the investigation cares
-- about and it keeps the index small next to bot-dominated staging traffic.
CREATE INDEX IF NOT EXISTS clue_guess_evaluations_created_idx
  ON public.clue_guess_evaluations (created_at DESC);

CREATE INDEX IF NOT EXISTS clue_guess_evaluations_rejects_idx
  ON public.clue_guess_evaluations (created_at DESC)
  WHERE NOT is_correct AND NOT is_ai;

CREATE INDEX IF NOT EXISTS clue_guess_evaluations_match_idx
  ON public.clue_guess_evaluations (match_id, q_index);

-- RLS on, no policies: service-role backend writes/reads only. Matches the
-- posture set by the 2026-07-02 RLS lockdown — anon must never reach this table,
-- since it contains free text keyed to user_id.
ALTER TABLE public.clue_guess_evaluations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.clue_guess_evaluations FROM anon;
REVOKE ALL ON public.clue_guess_evaluations FROM authenticated;

COMMENT ON TABLE public.clue_guess_evaluations IS
  'Append-only forensic log of free-text clue guess evaluations. Instrumentation for the "correct answers marked wrong" investigation; also gold-standard clue-behavior data for bot calibration. Safe to prune by created_at.';
