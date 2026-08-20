-- Commitment v3 commits to an ordered list of per-zone question digests.
-- Proofs can therefore reveal and verify only dealt questions without leaking
-- the answer keys for zones a player never reached.

update public.road_to_goal_commitments
set status = 'expired'
where commitment_version = 2
  and status = 'prepared';

alter table public.road_to_goal_commitments
  drop constraint if exists road_to_goal_commitments_commitment_version_check;

alter table public.road_to_goal_commitments
  add constraint road_to_goal_commitments_commitment_version_check
  check (commitment_version in (2, 3)) not valid;

alter table public.road_to_goal_commitments
  validate constraint road_to_goal_commitments_commitment_version_check;

alter table public.road_to_goal_rounds
  drop constraint if exists road_to_goal_rounds_commitment_version;

alter table public.road_to_goal_rounds
  add constraint road_to_goal_rounds_commitment_version
  check (commitment_version is null or commitment_version in (2, 3)) not valid;

alter table public.road_to_goal_rounds
  validate constraint road_to_goal_rounds_commitment_version;

comment on column public.road_to_goal_commitments.question_set_hash is
  'SHA-256 of the canonical ordered per-zone question digest list; v3 proofs disclose only dealt leaves.';
