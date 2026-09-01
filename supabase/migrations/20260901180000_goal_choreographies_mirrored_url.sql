-- Self-hosted copy of each goal clip.
--
-- Embedded YouTube playback is not durable: rights holders disable "playback
-- on other websites" after the fact and the app then shows "Video unavailable"
-- mid-game. We mirror the clips to our own CDN and serve those instead.
--
-- video_url is deliberately kept: it stays the attributable source and the
-- fallback for anything not yet mirrored.
ALTER TABLE goal_choreographies ADD COLUMN IF NOT EXISTS mirrored_url text;

COMMENT ON COLUMN goal_choreographies.mirrored_url IS
  'Self-hosted copy on our CDN. Preferred by the player; video_url stays as the attributable source and fallback.';
