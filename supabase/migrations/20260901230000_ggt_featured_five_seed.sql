-- Curated onboarding: pin the launch five in fixed order. Idempotent — rows
-- missing in an environment are skipped; re-running converges to this state.
UPDATE goal_choreographies SET featured_rank = NULL WHERE featured_rank IS NOT NULL;
UPDATE goal_choreographies SET featured_rank = 1 WHERE slug = 'bale-copa-final-2014';
UPDATE goal_choreographies SET featured_rank = 2 WHERE slug = 'cristiano-juventus-2018';
UPDATE goal_choreographies SET featured_rank = 3 WHERE slug = 'roberto-carlos-france-1997';
UPDATE goal_choreographies SET featured_rank = 4 WHERE slug = 'zidane-ucl-final-2002';
UPDATE goal_choreographies SET featured_rank = 5 WHERE slug = 'ibrahimovic-england-2012';

-- Duplicate ranks would fall through to random() and make the curated order
-- nondeterministic — refuse them at the schema level.
CREATE UNIQUE INDEX IF NOT EXISTS uq_goal_choreographies_featured_rank
  ON goal_choreographies (featured_rank) WHERE featured_rank IS NOT NULL;
