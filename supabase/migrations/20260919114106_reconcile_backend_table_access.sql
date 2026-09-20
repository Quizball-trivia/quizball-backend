-- The server resolves Pass Chain answers. Browser Data API roles must not
-- read the answer graph or write it directly; this also repairs staging.
ALTER TABLE public.pass_chain_players ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pass_chain_players FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pass_chain_players TO service_role;

-- Preserve production's internal ticket-refill access after guest exclusion.
REVOKE EXECUTE ON FUNCTION public.refill_tickets_global() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refill_tickets_global() TO service_role;
