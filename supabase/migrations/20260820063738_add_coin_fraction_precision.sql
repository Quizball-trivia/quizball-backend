-- Exact fractional coin support for games with decimal multipliers.
--
-- Existing economy paths continue to read/write users.coins as whole coins.
-- Fractional value is held separately as an integer remainder so no floating
-- point value ever becomes financial state. The canonical balance in minor
-- units is: users.coins * 100 + users.coin_fraction_minor.

alter table public.users
  add column if not exists coin_fraction_minor smallint not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_coin_fraction_minor_range'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_coin_fraction_minor_range
      check (coin_fraction_minor between 0 and 99) not valid;
  end if;
end
$$;

alter table public.users
  validate constraint users_coin_fraction_minor_range;

-- Preserve the historic whole-coin column for compatibility while giving the
-- immutable ledger an exact minor-unit amount for fractional game settlement.
alter table public.store_transaction_logs
  add column if not exists coins_delta_minor bigint;

-- Keep this nullable during the online rollout. Historic rows are interpreted
-- as coins_delta * 100 and can be backfilled later in bounded batches. A
-- default of zero would silently corrupt writes from an older application
-- replica that does not know about the minor-unit column.
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
    select 1
    from pg_constraint
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

comment on column public.users.coin_fraction_minor is
  'Fractional coin remainder in hundredths; total minor balance = coins * 100 + this value.';

comment on column public.store_transaction_logs.coins_delta_minor is
  'Exact coin delta in hundredths. NULL historic rows mean coins_delta * 100 during the online rollout.';

revoke all on function public.store_transaction_logs_fill_coin_minor()
  from public, anon, authenticated;
