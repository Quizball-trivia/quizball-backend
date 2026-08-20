-- Adversarial-review hardening for Road to Goal.
--
-- 1. The server commits to its seed, fixed round id, calibration version and
--    rules before it ever receives the player's seed.
-- 2. Accuracy is calibrated per question *and zone* so survivor-selection
--    effects do not silently raise population RTP in later zones.

alter table public.road_to_goal_calibration_versions
  add column if not exists rules_version smallint not null default 1
    check (rules_version between 1 and 32767);

alter table public.road_to_goal_calibration_versions
  drop constraint if exists road_to_goal_calibration_versions_publication_day_key;

create unique index if not exists uq_road_to_goal_calibration_day_rules
  on public.road_to_goal_calibration_versions (publication_day, rules_version);

create table if not exists public.road_to_goal_commitments (
  round_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete restrict,
  request_nonce uuid not null,
  stake_coins integer not null check (stake_coins in (10, 25, 50)),
  auto_cashout_zone smallint check (auto_cashout_zone between 1 and 10),
  calibration_version_id uuid not null
    references public.road_to_goal_calibration_versions(id) on delete restrict,
  commitment_version smallint not null check (commitment_version = 3),
  server_seed text not null check (server_seed ~ '^[0-9a-f]{64}$'),
  commit_hash text not null check (commit_hash ~ '^[0-9a-f]{64}$'),
  rules_manifest jsonb not null check (jsonb_typeof(rules_manifest) = 'object'),
  rules_manifest_hash text not null check (rules_manifest_hash ~ '^[0-9a-f]{64}$'),
  run_questions jsonb not null constraint road_to_goal_commitments_run_questions_shape check (
    jsonb_typeof(run_questions) = 'array' and jsonb_array_length(run_questions) = 11
  ),
  question_set_hash text not null constraint road_to_goal_commitments_question_set_hash_format
    check (question_set_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'prepared'
    check (status in ('prepared', 'consumed', 'expired')),
  expires_at timestamptz not null default (clock_timestamp() + interval '5 minutes'),
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, request_nonce),
  check (
    (status = 'consumed' and consumed_at is not null)
    or (status <> 'consumed' and consumed_at is null)
  )
);

create unique index if not exists uq_road_to_goal_prepared_commitment
  on public.road_to_goal_commitments (user_id)
  where status = 'prepared';

create index if not exists idx_road_to_goal_commitments_expiry
  on public.road_to_goal_commitments (expires_at)
  where status = 'prepared';

alter table public.road_to_goal_rounds
  add column if not exists commitment_version smallint,
  add column if not exists rules_manifest_hash text,
  add column if not exists question_set_hash text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'road_to_goal_rounds_commitment_version'
      and conrelid = 'public.road_to_goal_rounds'::regclass
  ) then
    alter table public.road_to_goal_rounds
      add constraint road_to_goal_rounds_commitment_version
      check (commitment_version is null or commitment_version = 3) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'road_to_goal_rounds_rules_manifest_hash_format'
      and conrelid = 'public.road_to_goal_rounds'::regclass
  ) then
    alter table public.road_to_goal_rounds
      add constraint road_to_goal_rounds_rules_manifest_hash_format
      check (rules_manifest_hash is null or rules_manifest_hash ~ '^[0-9a-f]{64}$') not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'road_to_goal_rounds_question_set_hash_format'
      and conrelid = 'public.road_to_goal_rounds'::regclass
  ) then
    alter table public.road_to_goal_rounds
      add constraint road_to_goal_rounds_question_set_hash_format
      check (question_set_hash is null or question_set_hash ~ '^[0-9a-f]{64}$') not valid;
  end if;
end
$$;

alter table public.road_to_goal_rounds
  validate constraint road_to_goal_rounds_commitment_version,
  validate constraint road_to_goal_rounds_rules_manifest_hash_format,
  validate constraint road_to_goal_rounds_question_set_hash_format;

create table if not exists public.road_to_goal_zone_question_calibrations (
  version_id uuid not null
    references public.road_to_goal_calibration_versions(id) on delete restrict,
  question_id uuid not null references public.questions(id) on delete restrict,
  zone smallint not null check (zone between 1 and 11),
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
  primary key (version_id, question_id, zone)
);

create index if not exists idx_road_to_goal_zone_calibrations_lookup
  on public.road_to_goal_zone_question_calibrations (version_id, question_id, zone);

alter table public.road_to_goal_commitments enable row level security;
alter table public.road_to_goal_zone_question_calibrations enable row level security;

revoke all on public.road_to_goal_commitments from anon, authenticated;
revoke all on public.road_to_goal_zone_question_calibrations from anon, authenticated;

comment on table public.road_to_goal_commitments is
  'Server seed commitments created before the player seed is disclosed.';
comment on table public.road_to_goal_zone_question_calibrations is
  'Immutable P(correct | served question, reached zone) calibration rows.';
