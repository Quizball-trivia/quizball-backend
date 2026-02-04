ALTER TABLE public.matches
  ADD COLUMN updated_at timestamp with time zone NOT NULL DEFAULT now();
