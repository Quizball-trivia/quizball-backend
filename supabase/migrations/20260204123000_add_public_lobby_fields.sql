-- Add public lobby fields and display name
ALTER TABLE public.lobbies
  ADD COLUMN is_public boolean NOT NULL DEFAULT false,
  ADD COLUMN display_name text NOT NULL DEFAULT '';

-- Speed up public lobby browsing
CREATE INDEX IF NOT EXISTS lobbies_public_waiting_idx
  ON public.lobbies (created_at DESC)
  WHERE status = 'waiting' AND is_public = true;
