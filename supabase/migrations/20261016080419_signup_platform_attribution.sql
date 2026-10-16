-- Backend-only, immutable origin of a real account. No historical guessing.
CREATE TABLE public.user_signup_attribution (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('web', 'android', 'ios', 'unknown')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1)
);

CREATE INDEX user_signup_attribution_recorded_at_idx
  ON public.user_signup_attribution (recorded_at);

ALTER TABLE public.user_signup_attribution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_signup_attribution FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.user_signup_attribution IS
  'Account creation source, recorded atomically by the backend. Missing pre-instrumentation history is unknown, not web. Never used for authorization.';
