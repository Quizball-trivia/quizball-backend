-- Idempotent follow-up for environments that applied the earlier development
-- version of the fractional-ledger migration before its online rollout was
-- hardened. Fresh databases already receive the same definitions there.

alter table public.store_transaction_logs
  alter column coins_delta_minor drop default,
  alter column coins_delta_minor drop not null;

create or replace function public.store_transaction_logs_fill_coin_minor()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.coins_delta_minor is null then
    new.coins_delta_minor := new.coins_delta::bigint * 100;
  elsif new.coins_delta <> trunc(new.coins_delta_minor::numeric / 100)::integer then
    raise exception 'coins_delta must be the whole-coin truncation of coins_delta_minor'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_store_transaction_logs_fill_coin_minor
  on public.store_transaction_logs;
create trigger trg_store_transaction_logs_fill_coin_minor
  before insert on public.store_transaction_logs
  for each row
  execute function public.store_transaction_logs_fill_coin_minor();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'store_transaction_logs_coin_minor_consistency'
      and conrelid = 'public.store_transaction_logs'::regclass
  ) then
    alter table public.store_transaction_logs
      add constraint store_transaction_logs_coin_minor_consistency
      check (
        coins_delta_minor is null
        or coins_delta = trunc(coins_delta_minor::numeric / 100)::integer
      ) not valid;
  end if;
end
$$;

revoke all on function public.store_transaction_logs_fill_coin_minor()
  from public, anon, authenticated;
