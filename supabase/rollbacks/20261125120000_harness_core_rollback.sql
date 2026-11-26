-- Rollback for 20261125120000_harness_core.sql: removes the new HQ harness
-- schema and everything in it. Published questions stay in public.questions.
DROP SCHEMA IF EXISTS harness CASCADE;
