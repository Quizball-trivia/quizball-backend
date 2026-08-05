-- Durable reveal timestamp for the round breather.
--
-- The pause between rounds was anchored to deadline_at_ms, which is when the
-- answer window closed — not when the reveal actually happened. After a crash
-- or restart a question can be revealed well after its deadline, making the
-- breather look already-elapsed and skipping the round-end standings beat.
-- Stamping the real reveal time makes the hold correct on every path.
ALTER TABLE wl_question_runs
  ADD COLUMN IF NOT EXISTS revealed_at_ms bigint;
