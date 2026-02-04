-- Add ON DELETE behavior to lobby foreign key columns
-- The columns are nullable, so SET NULL is the appropriate choice

-- Drop the existing foreign key constraints (they have no explicit names, so we need to recreate them)
ALTER TABLE public.lobbies
  DROP CONSTRAINT lobbies_friendly_category_a_id_fkey,
  DROP CONSTRAINT lobbies_friendly_category_b_id_fkey;

-- Recreate the constraints with explicit ON DELETE SET NULL behavior
ALTER TABLE public.lobbies
  ADD CONSTRAINT lobbies_friendly_category_a_id_fkey
    FOREIGN KEY (friendly_category_a_id) REFERENCES public.categories(id) ON DELETE SET NULL,
  ADD CONSTRAINT lobbies_friendly_category_b_id_fkey
    FOREIGN KEY (friendly_category_b_id) REFERENCES public.categories(id) ON DELETE SET NULL;
