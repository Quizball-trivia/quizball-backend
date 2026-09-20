-- Reconcile an existing staging index with one bounded online statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_ticket_refill_candidates ON public.users USING btree (id) WHERE ((tickets < 5) AND (tickets_refill_started_at IS NOT NULL) AND (is_ai = false) AND (is_deleted = false) AND (deleted_at IS NULL) AND (pending_deletion_at IS NULL));
