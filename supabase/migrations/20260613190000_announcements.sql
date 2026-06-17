-- CMS-authored news announcements shown in the player app's "News" list.
--
-- Replaces the previously hardcoded announcement array on the web Play screen:
-- admins create/edit announcements in the CMS (en + ka text stored directly as
-- data, not i18n keys) so new news needs no deploy. The public feed returns
-- only active announcements within their optional active window.

CREATE TABLE IF NOT EXISTS public.announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title jsonb NOT NULL,                 -- i18n {en, ka, ...}
  body jsonb NOT NULL,                  -- i18n {en, ka, ...}
  type text NOT NULL DEFAULT 'update'
    CHECK (type IN ('update', 'info', 'event')),
  is_active boolean NOT NULL DEFAULT true,
  active_from timestamptz,              -- optional publish window start (null = always)
  active_to timestamptz,               -- optional publish window end (null = never expires)
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Public feed: active announcements newest first. Partial index keeps the hot
-- read (is_active = true) small.
CREATE INDEX IF NOT EXISTS idx_announcements_active_created
  ON public.announcements (created_at DESC)
  WHERE is_active = true;
