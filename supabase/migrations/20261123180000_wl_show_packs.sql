-- Show packs (hand-written question sets for host-run show nights) live in the
-- database, never in this public repo. One pack per (slug, Monday); the
-- orchestrator loads it into that week's event until the host presses Start.
-- Loaded per environment by scripts/wl-show-pack-load.ts --file <private path>.
CREATE TABLE IF NOT EXISTS public.wl_show_packs (
  slug text NOT NULL,
  event_date date NOT NULL,
  pack jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, event_date)
);

-- Answer keys: backend only, no client access.
ALTER TABLE public.wl_show_packs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wl_show_packs FROM anon, authenticated;
