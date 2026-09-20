-- migrate:no-transaction
-- getRecentQuestionIds filters by user, reads newest events first, and then
-- de-duplicates the bounded result.  The older (user_id, question_id) index
-- cannot satisfy ORDER BY id DESC, which forces a sort of a user's full event
-- history and can saturate the shared database when bot rounds run in parallel.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_free_kicks_events_user_recent_question
  ON public.free_kicks_events (user_id, id DESC)
  INCLUDE (question_id)
  WHERE question_id IS NOT NULL;
