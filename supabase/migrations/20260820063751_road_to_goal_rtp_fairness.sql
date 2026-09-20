-- Road to Goal v2: 98% population RTP, skill-modified survival, immutable
-- calibration snapshots, exact decimal payouts, and verifiable HMAC rolls.

create table if not exists public.road_to_goal_calibration_versions (
  id uuid primary key default gen_random_uuid(),
  publication_day date not null unique,
  target_rtp_bp smallint not null check (target_rtp_bp between 1 and 10000),
  skill_gap_bp smallint not null check (skill_gap_bp between 0 and 5000),
  easy_prior_bp smallint not null check (easy_prior_bp between 0 and 10000),
  medium_prior_bp smallint not null check (medium_prior_bp between 0 and 10000),
  hard_prior_bp smallint not null check (hard_prior_bp between 0 and 10000),
  minimum_accuracy_bp smallint not null check (minimum_accuracy_bp between 0 and 10000),
  maximum_accuracy_bp smallint not null check (maximum_accuracy_bp between 0 and 10000),
  minimum_survival_bp smallint not null check (minimum_survival_bp between 0 and 10000),
  maximum_survival_bp smallint not null check (maximum_survival_bp between 0 and 10000),
  minimum_road_answers integer not null check (minimum_road_answers >= 0),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  created_at timestamptz not null default now(),
  check (minimum_accuracy_bp <= maximum_accuracy_bp),
  check (minimum_survival_bp <= maximum_survival_bp)
);

create table if not exists public.road_to_goal_question_calibrations (
  version_id uuid not null references public.road_to_goal_calibration_versions(id) on delete restrict,
  question_id uuid not null references public.questions(id) on delete restrict,
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  expected_accuracy_bp smallint not null check (expected_accuracy_bp between 0 and 10000),
  ranked_answer_count integer not null default 0 check (ranked_answer_count >= 0),
  road_answer_count integer not null default 0 check (road_answer_count >= 0),
  road_correct_count integer not null default 0 check (
    road_correct_count >= 0 and road_correct_count <= road_answer_count
  ),
  road_timeout_count integer not null default 0 check (
    road_timeout_count >= 0 and road_timeout_count <= road_answer_count
  ),
  source text not null check (source in ('difficulty_prior', 'ranked', 'blended', 'road')),
  created_at timestamptz not null default now(),
  primary key (version_id, question_id)
);

create index if not exists idx_road_to_goal_question_calibrations_question
  on public.road_to_goal_question_calibrations (question_id, version_id);

alter table public.road_to_goal_rounds
  alter column payout_coins type numeric(12, 2)
    using payout_coins::numeric(12, 2),
  add column if not exists calibration_version_id uuid
    references public.road_to_goal_calibration_versions(id) on delete restrict,
  add column if not exists server_seed text,
  add column if not exists commit_hash text,
  add column if not exists client_seed text,
  add column if not exists auto_cashout_zone smallint,
  add column if not exists decision_deadline_at timestamptz,
  add column if not exists settlement_reason text;

create index if not exists idx_road_to_goal_rounds_calibration_version
  on public.road_to_goal_rounds (calibration_version_id)
  where calibration_version_id is not null;

create index if not exists idx_road_to_goal_rounds_decision_deadline
  on public.road_to_goal_rounds (decision_deadline_at)
  where status = 'active' and phase = 'decision';

-- Compatibility for any development round created by the unpublished v1
-- migration before this additive migration is applied.
update public.road_to_goal_rounds
set decision_deadline_at = coalesce(last_seen_at, now()) + interval '5 minutes'
where phase = 'decision'
  and decision_deadline_at is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'road_to_goal_rounds_server_seed_format'
      and conrelid = 'public.road_to_goal_rounds'::regclass
  ) then
    alter table public.road_to_goal_rounds
      add constraint road_to_goal_rounds_server_seed_format
      check (server_seed is null or server_seed ~ '^[0-9a-f]{64}$') not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'road_to_goal_rounds_commit_hash_format'
      and conrelid = 'public.road_to_goal_rounds'::regclass
  ) then
    alter table public.road_to_goal_rounds
      add constraint road_to_goal_rounds_commit_hash_format
      check (commit_hash is null or commit_hash ~ '^[0-9a-f]{64}$') not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'road_to_goal_rounds_client_seed_length'
      and conrelid = 'public.road_to_goal_rounds'::regclass
  ) then
    alter table public.road_to_goal_rounds
      add constraint road_to_goal_rounds_client_seed_length
      check (client_seed is null or char_length(client_seed) between 1 and 128) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'road_to_goal_rounds_auto_cashout_zone_range'
      and conrelid = 'public.road_to_goal_rounds'::regclass
  ) then
    alter table public.road_to_goal_rounds
      add constraint road_to_goal_rounds_auto_cashout_zone_range
      check (auto_cashout_zone is null or auto_cashout_zone between 1 and 11) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'road_to_goal_rounds_decision_deadline_phase'
      and conrelid = 'public.road_to_goal_rounds'::regclass
  ) then
    alter table public.road_to_goal_rounds
      add constraint road_to_goal_rounds_decision_deadline_phase
      check ((phase = 'decision') = (decision_deadline_at is not null)) not valid;
  end if;
end
$$;

alter table public.road_to_goal_rounds
  validate constraint road_to_goal_rounds_server_seed_format,
  validate constraint road_to_goal_rounds_commit_hash_format,
  validate constraint road_to_goal_rounds_client_seed_length,
  validate constraint road_to_goal_rounds_auto_cashout_zone_range,
  validate constraint road_to_goal_rounds_decision_deadline_phase;

alter table public.road_to_goal_events
  alter column payout_coins type numeric(12, 2)
    using payout_coins::numeric(12, 2),
  add column if not exists request_nonce uuid,
  add column if not exists expected_accuracy_bp smallint,
  add column if not exists target_survival_bp smallint,
  add column if not exists correct_survival_bp smallint,
  add column if not exists wrong_survival_bp smallint,
  add column if not exists applied_survival_bp smallint,
  add column if not exists roll_bp smallint,
  add column if not exists survived boolean;

do $$
declare
  column_name text;
begin
  foreach column_name in array array[
    'expected_accuracy_bp',
    'target_survival_bp',
    'correct_survival_bp',
    'wrong_survival_bp',
    'applied_survival_bp',
    'roll_bp'
  ]
  loop
    if not exists (
      select 1 from pg_constraint
      where conname = 'road_to_goal_events_' || column_name || '_range'
        and conrelid = 'public.road_to_goal_events'::regclass
    ) then
      execute format(
        'alter table public.road_to_goal_events add constraint %I check (%I is null or %I between 0 and 10000) not valid',
        'road_to_goal_events_' || column_name || '_range',
        column_name,
        column_name
      );
    end if;
  end loop;
end
$$;

alter table public.road_to_goal_events
  validate constraint road_to_goal_events_expected_accuracy_bp_range,
  validate constraint road_to_goal_events_target_survival_bp_range,
  validate constraint road_to_goal_events_correct_survival_bp_range,
  validate constraint road_to_goal_events_wrong_survival_bp_range,
  validate constraint road_to_goal_events_applied_survival_bp_range,
  validate constraint road_to_goal_events_roll_bp_range;

create unique index if not exists uq_road_to_goal_event_request_nonce
  on public.road_to_goal_events (round_id, request_nonce)
  where request_nonce is not null;

create index if not exists idx_road_to_goal_events_question_calibration
  on public.road_to_goal_events (question_id, created_at)
  where event_type in ('answer', 'timeout');

alter table public.road_to_goal_calibration_versions enable row level security;
alter table public.road_to_goal_question_calibrations enable row level security;

revoke all on public.road_to_goal_calibration_versions from anon, authenticated;
revoke all on public.road_to_goal_question_calibrations from anon, authenticated;

comment on table public.road_to_goal_calibration_versions is
  'Immutable daily configuration used to calibrate Road to Goal to a 98% population RTP.';

comment on table public.road_to_goal_question_calibrations is
  'Per-question expected answer accuracy pinned to an immutable calibration version.';
