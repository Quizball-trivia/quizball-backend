-- A dedicated, tiny key table gives Road to Goal exact stake/payout
-- idempotency without building an index across the historical global ledger.
CREATE TABLE IF NOT EXISTS public.road_to_goal_ledger_keys (
  idempotency_key text PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES public.road_to_goal_rounds(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('road_to_goal_stake', 'road_to_goal_payout')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (round_id, event_type)
);

ALTER TABLE public.road_to_goal_ledger_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.road_to_goal_ledger_keys FROM anon, authenticated;

-- Backfill any development/staging rounds settled before this table existed.
-- The round is authoritative for ownership, and the global ledger proves that
-- the stake or payout transaction committed. ON CONFLICT also tolerates a
-- duplicate historical log if an interrupted index build admitted one.
INSERT INTO public.road_to_goal_ledger_keys (
  idempotency_key,
  round_id,
  user_id,
  event_type,
  created_at
)
SELECT
  'road-to-goal:' || round.id::text || ':' ||
    CASE ledger.event_type
      WHEN 'road_to_goal_stake' THEN 'stake'
      ELSE 'payout'
    END,
  round.id,
  round.user_id,
  ledger.event_type,
  min(ledger.created_at)
FROM public.road_to_goal_rounds round
JOIN public.store_transaction_logs ledger
  ON ledger.user_id = round.user_id
 AND ledger.event_type IN ('road_to_goal_stake', 'road_to_goal_payout')
 AND ledger.idempotency_key = 'road-to-goal:' || round.id::text || ':' ||
   CASE ledger.event_type
     WHEN 'road_to_goal_stake' THEN 'stake'
     ELSE 'payout'
   END
GROUP BY round.id, round.user_id, ledger.event_type
ON CONFLICT DO NOTHING;
