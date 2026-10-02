-- Weekend League reward delivery: one receipt per player per weekend.
--
-- Settlement first FREEZES every entitlement for a completed tournament
-- (band, coins, items, human rank) as 'pending' rows, then pays them one by
-- one. Freezing first means a retry can never re-rank the field and promote a
-- second player into a band that was already paid.
--
-- The receipt row is the idempotency authority: a payment only happens in the
-- transaction that flips its row from 'pending' to 'granted'.
CREATE TABLE IF NOT EXISTS public.wl_reward_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.wl_tournaments(id),
  -- Frozen at settlement so a later relabel of the tournament cannot move a
  -- paid reward to another weekend. Always set for real tournaments; NULL only
  -- for non-prod test tournaments that opted into payouts.
  week_key date,
  user_id uuid NOT NULL REFERENCES public.users(id),
  policy_version integer NOT NULL,
  band text NOT NULL CHECK (band IN (
    'participant', 'finalist', 'top10', 'third', 'second', 'winner'
  )),
  -- Rank among eligible humans who played the final; NULL below the final.
  human_rank integer,
  coins integer NOT NULL CHECK (coins >= 0),
  -- [{slug, avatarPartId, slot, alreadyOwned?}]; alreadyOwned is set at grant.
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'forfeited')),
  forfeit_reason text,
  frozen_at timestamptz NOT NULL DEFAULT NOW(),
  granted_at timestamptz,
  seen_at timestamptz,
  -- Failed grant attempts; the least recently tried receipt goes first so a
  -- receipt that keeps failing cannot block the ones behind it.
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text,
  UNIQUE (tournament_id, user_id),
  CHECK ((status = 'granted') = (granted_at IS NOT NULL))
);

-- One reward per player per weekend, even if two tournament rows exist for it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wl_reward_receipts_week_user
  ON public.wl_reward_receipts (week_key, user_id)
  WHERE week_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wl_reward_receipts_user
  ON public.wl_reward_receipts (user_id, granted_at DESC);

CREATE INDEX IF NOT EXISTS idx_wl_reward_receipts_pending
  ON public.wl_reward_receipts (tournament_id)
  WHERE status = 'pending';

ALTER TABLE public.wl_reward_receipts ENABLE ROW LEVEL SECURITY;

-- Settlement progress per tournament. Kept off wl_tournaments on purpose: that
-- row is on the live event path, and stamping it would also bump its
-- updated_at and keep finished events in the orchestrator's healing window.
CREATE TABLE IF NOT EXISTS public.wl_reward_settlements (
  tournament_id uuid PRIMARY KEY REFERENCES public.wl_tournaments(id),
  frozen_at timestamptz,
  settled_at timestamptz,
  -- Durable retry state, so fairness and backoff survive restarts and are
  -- shared by every replica.
  attempted_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE public.wl_reward_settlements ENABLE ROW LEVEL SECURITY;
