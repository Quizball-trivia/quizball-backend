-- Keep backend-only operational/content tables unreachable from the Data API.
--
-- These objects are accessed through the backend's direct postgres connection
-- (or trusted service-role jobs), never directly by browser/mobile clients.
-- Do not FORCE ROW LEVEL SECURITY: the postgres owner must continue to serve
-- the API, CMS, ingestion jobs, and ranked early-forfeit transaction.

ALTER TABLE public.auction_card_clues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auction_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_tuning_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_player_market_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.llm_generation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_clue_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_market_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ranked_early_forfeit_events ENABLE ROW LEVEL SECURITY;

-- RLS without policies denies Data API rows. Revoke object privileges as a
-- second boundary so accidental policies cannot make these server-only tables
-- client-accessible later.
REVOKE ALL PRIVILEGES ON TABLE public.auction_card_clues FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.auction_cards FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.bot_tuning_overrides FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.football_player_market_values FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.football_players FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.import_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.llm_generation_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.player_clue_cards FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.player_facts FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.player_market_values FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.ranked_early_forfeit_events FROM PUBLIC, anon, authenticated;

-- Views owned by postgres otherwise evaluate with owner privileges and can
-- bypass base-table RLS. Make that impossible and remove direct client access.
ALTER VIEW public.auction_player_pricing SET (security_invoker = true);
ALTER VIEW public.auction_player_eligibility_summary SET (security_invoker = true);
ALTER VIEW public.player_clue_generation_candidates SET (security_invoker = true);
ALTER VIEW public.player_clue_card_content_view SET (security_invoker = true);

REVOKE ALL PRIVILEGES ON TABLE public.auction_player_pricing FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.auction_player_eligibility_summary FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.player_clue_generation_candidates FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.player_clue_card_content_view FROM PUBLIC, anon, authenticated;

-- Prevent the same exposure from recurring on new objects created by postgres.
-- Client-facing objects must opt in with explicit grants plus reviewed policies.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Deployment guard: fail the migration if any intended boundary is missing.
DO $$
DECLARE
  target_table text;
  target_view text;
  target_role text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'auction_card_clues',
    'auction_cards',
    'bot_tuning_overrides',
    'football_player_market_values',
    'football_players',
    'import_runs',
    'llm_generation_runs',
    'player_clue_cards',
    'player_facts',
    'player_market_values',
    'ranked_early_forfeit_events'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = target_table
        AND c.relkind IN ('r', 'p')
        AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'RLS postcondition failed for public.%', target_table;
    END IF;

    FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(target_role, format('public.%I', target_table), 'SELECT')
        OR has_table_privilege(target_role, format('public.%I', target_table), 'INSERT')
        OR has_table_privilege(target_role, format('public.%I', target_table), 'UPDATE')
        OR has_table_privilege(target_role, format('public.%I', target_table), 'DELETE')
      THEN
        RAISE EXCEPTION 'Privilege postcondition failed for role % on public.%',
          target_role, target_table;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH target_view IN ARRAY ARRAY[
    'auction_player_pricing',
    'auction_player_eligibility_summary',
    'player_clue_generation_candidates',
    'player_clue_card_content_view'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = target_view
        AND c.relkind = 'v'
        AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
    ) THEN
      RAISE EXCEPTION 'security_invoker postcondition failed for public.%', target_view;
    END IF;

    FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(target_role, format('public.%I', target_view), 'SELECT') THEN
        RAISE EXCEPTION 'View privilege postcondition failed for role % on public.%',
          target_role, target_view;
      END IF;
    END LOOP;
  END LOOP;
END
$$;
