-- Guess the Goal: optional YouTube link per goal — served ONLY after the guess
-- (the video title would leak the answer), so it lives in the session snapshot
-- and the guess-outcome payload, never in the pre-guess session DTO.
-- Column and constraint added separately: an inline CHECK inside
-- ADD COLUMN IF NOT EXISTS is silently skipped when the column already exists.
-- Only real video paths are accepted (watch/shorts/embed/youtu.be) — a bare
-- youtube.com prefix would admit redirect and channel URLs.
ALTER TABLE public.goal_choreographies
  ADD COLUMN IF NOT EXISTS video_url text;

DO $$
BEGIN
  ALTER TABLE public.goal_choreographies
    ADD CONSTRAINT goal_choreographies_video_url_format_check
    CHECK (
      video_url IS NULL
      OR video_url ~ '^https://((www\.)?youtube\.com/(watch\?v=|shorts/|embed/)[A-Za-z0-9_-]{6,}|youtu\.be/[A-Za-z0-9_-]{6,})'
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
