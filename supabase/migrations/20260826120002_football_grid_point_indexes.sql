-- migrate:no-transaction
-- Remove the first draft's users.updated_at index if it was applied locally.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_users_tic_tac_toe_points_desc;
