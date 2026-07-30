-- PR8: persist the CLEAN-WINDOW timing sample count separately from the accuracy
-- answer count. Accuracy (answers_count) and timing (timing_samples) can differ
-- materially — a question can have many pre-clean-window accuracy answers but few
-- clean-window timing samples (or vice versa). The backoff resolver gates
-- accuracy and timing INDEPENDENTLY, each against its own sample count, so
-- reusing answers_count as the timing count would let a question back off timing
-- to the wrong scope. The aggregation already computes this count; it was simply
-- dropped on write until now.
--
-- Additive + nullable (expand/contract-safe): old rows keep NULL and readers fall
-- back to answers_count until the next refresh repopulates the column. Idempotent.

ALTER TABLE public.question_stats
  ADD COLUMN IF NOT EXISTS timing_samples integer;

ALTER TABLE public.question_stats_backoff
  ADD COLUMN IF NOT EXISTS timing_samples integer;
