-- Idempotent follow-up for development databases that applied the commitment
-- table before ordered question/calibration snapshots were pinned pre-seed.

alter table public.road_to_goal_commitments
  add column if not exists run_questions jsonb,
  add column if not exists question_set_hash text;

alter table public.road_to_goal_rounds
  add column if not exists question_set_hash text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'road_to_goal_commitments_run_questions_shape'
      and conrelid = 'public.road_to_goal_commitments'::regclass
  ) then
    alter table public.road_to_goal_commitments
      add constraint road_to_goal_commitments_run_questions_shape
      check (
        run_questions is null or (
          jsonb_typeof(run_questions) = 'array'
          and jsonb_array_length(run_questions) = 11
        )
      ) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'road_to_goal_commitments_question_set_hash_format'
      and conrelid = 'public.road_to_goal_commitments'::regclass
  ) then
    alter table public.road_to_goal_commitments
      add constraint road_to_goal_commitments_question_set_hash_format
      check (question_set_hash is null or question_set_hash ~ '^[0-9a-f]{64}$') not valid;
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
