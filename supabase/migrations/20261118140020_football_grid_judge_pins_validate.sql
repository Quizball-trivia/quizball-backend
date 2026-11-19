-- Validate the judge-version foreign keys added NOT VALID in 20261118140010. VALIDATE takes SHARE UPDATE EXCLUSIVE:
-- reads and writes on the Grid tables continue while it scans.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.football_grid_matches VALIDATE CONSTRAINT football_grid_matches_judge_version_fk;
ALTER TABLE public.football_grid_claims VALIDATE CONSTRAINT football_grid_claims_judge_alias_fk;
