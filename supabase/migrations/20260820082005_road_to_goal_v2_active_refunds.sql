-- Commitment v3 cannot safely reveal a v2 proof. Refund and close any active
-- development v2 round so a deducted stake can never become stranded during
-- the upgrade. The payout ledger key makes the compensation idempotent.

with refundable as (
  select round.id, round.user_id, round.stake_coins
  from public.road_to_goal_rounds round
  where round.status = 'active'
    and round.commitment_version = 2
), logged as (
  insert into public.store_transaction_logs (
    event_type,
    outcome,
    user_id,
    coins_delta,
    coins_delta_minor,
    reason,
    idempotency_key
  )
  select
    'road_to_goal_payout',
    'success',
    refundable.user_id,
    refundable.stake_coins,
    refundable.stake_coins::bigint * 100,
    'road_to_goal_v2_migration_refund',
    'road-to-goal:' || refundable.id::text || ':payout'
  from refundable
  on conflict do nothing
  returning user_id, coins_delta_minor
)
update public.users user_wallet
set
  coins = (
    (
      user_wallet.coins::bigint * 100
      + user_wallet.coin_fraction_minor::bigint
      + logged.coins_delta_minor
    ) / 100
  )::integer,
  coin_fraction_minor = (
    (
      user_wallet.coins::bigint * 100
      + user_wallet.coin_fraction_minor::bigint
      + logged.coins_delta_minor
    ) % 100
  )::smallint,
  updated_at = clock_timestamp()
from logged
where user_wallet.id = logged.user_id;

update public.road_to_goal_rounds
set
  status = 'lost',
  phase = 'settled',
  settlement_reason = 'road_to_goal_v2_migration_refund',
  question_deadline_at = null,
  decision_deadline_at = null,
  payout_coins = null,
  settled_at = clock_timestamp()
where status = 'active'
  and commitment_version = 2;
