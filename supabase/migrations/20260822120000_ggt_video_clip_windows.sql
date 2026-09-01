-- Goal video clip windows: when set, the client embed plays exactly
-- [clip_start_s, clip_end_s] of the source upload instead of the whole
-- broadcast from an arbitrary timestamp. Nullable pair — goals without a
-- verified window keep playing from the URL's own ?t= offset.
ALTER TABLE public.goal_choreographies
  ADD COLUMN clip_start_s integer,
  ADD COLUMN clip_end_s integer;

ALTER TABLE public.goal_choreographies
  ADD CONSTRAINT chk_ggt_clip_window CHECK (
    (clip_start_s IS NULL AND clip_end_s IS NULL)
    OR (clip_start_s IS NOT NULL AND clip_end_s IS NOT NULL AND clip_start_s < clip_end_s)
  );
