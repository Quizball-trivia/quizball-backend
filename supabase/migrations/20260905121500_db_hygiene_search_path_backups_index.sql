-- Database hygiene from the 2026-09-05 Supabase advisor pass. No behaviour change.
--
-- 1. Pin search_path on the functions the security advisor flags as mutable.
--    Pinned to the schemas each body actually resolves against (several use
--    unqualified public tables, the agents ones cast to extensions.vector), so
--    nothing that works today stops resolving. Guarded so the file also applies
--    on databases where a function does not exist.
-- 2. Drop the ivfflat index on agents.question_embeddings: 58 MB, 22x bloated,
--    and never scanned — agents.match_question_embedding filters by category
--    first, so the planner reads the 7k-row table directly.
-- 3. Drop three ad-hoc backup tables from August (no primary key, unused since
--    their repairs landed). Exported to backend-node/backups/prod-backup-tables-20260905/
--    as CSV + column lists before this migration was written.

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.trigger_set_updated_at()',
    'public.simulate_leaderboard_movement()',
    'public.free_kicks_rounds_touch_updated_at()',
    'public.wl_tournaments_policy_immutable()',
    'public.wl_awards_guard()',
    'public.wl_award_actions_append_only()',
    'public.prevent_card_family_identity_change()',
    'public.wl_mark_question_seen()'
  ] LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public', fn);
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'agents.active_daily_challenges()',
    'agents.claim_next_job(text)',
    'agents.match_question_embedding(uuid, text, integer)',
    'agents.oldest_categories(integer)',
    'agents.save_prompt(text, text, text, text, uuid)',
    'agents.touch_updated_at()',
    'agents.upsert_question_embedding(uuid, uuid, text, text)'
  ] LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = agents, public, extensions', fn);
    END IF;
  END LOOP;
END $$;

DROP INDEX IF EXISTS agents.question_embeddings_cosine_idx;

DROP TABLE IF EXISTS
  public.question_payload_backup_aug30,
  public.clue_sync_backup_20260826,
  public.wl_questions_backup_aug22;
