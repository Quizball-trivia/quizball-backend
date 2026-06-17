-- Friend search optimization: trigram index for the social-tab user search.
--
-- The search (users.repo.ts searchByNickname) runs:
--   nickname ILIKE '%term%'  (leading wildcard, case-insensitive)
-- which no btree index can serve — today it full-scans the partial
-- idx_users_active_public index (~all active users) on every debounced
-- keystroke. Fine at ~4k users (~8ms), linear blowup as the user base grows.
--
-- pg_trgm GIN is the canonical fix: it serves ILIKE '%term%' directly and
-- keeps search cost ~flat with user growth. The partial predicate mirrors the
-- query's WHERE clauses exactly so the planner can use it. Note: the planner
-- may still prefer a scan while the table is small — the index pays off as
-- the table grows (and for 3+ char terms, which the frontend now enforces).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_users_nickname_trgm
  ON public.users USING gin (nickname gin_trgm_ops)
  WHERE is_ai = false
    AND is_deleted = false
    AND deleted_at IS NULL
    AND pending_deletion_at IS NULL
    AND nickname IS NOT NULL;
