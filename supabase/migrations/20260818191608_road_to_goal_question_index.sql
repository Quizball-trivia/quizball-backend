-- The UUID-pivot selector already uses the questions primary key and bounded
-- result windows. Remove any interrupted optional accelerator instead of
-- blocking the launch on a full-table online build through the pooler.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_questions_road_to_goal_eligible;
