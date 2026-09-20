-- Idempotent follow-up for development databases that applied the first
-- safety-review migration before same-day rules-versioned calibration was
-- introduced.

alter table public.road_to_goal_calibration_versions
  add column if not exists rules_version smallint not null default 1
    check (rules_version between 1 and 32767);

alter table public.road_to_goal_calibration_versions
  drop constraint if exists road_to_goal_calibration_versions_publication_day_key;

create unique index if not exists uq_road_to_goal_calibration_day_rules
  on public.road_to_goal_calibration_versions (publication_day, rules_version);
