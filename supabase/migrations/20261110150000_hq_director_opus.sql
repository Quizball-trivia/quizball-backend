-- The Executive Director runs on Claude Opus 5.5 at extra-high effort
-- (owner decision 2026-11-10), instead of Fable 5.2 at medium. Only the seeded
-- values are replaced, so a model set by hand in the CMS is left alone.
UPDATE hq.members
   SET model = 'claude-opus-5-5', effort = 'xhigh', updated_at = now()
 WHERE slug = 'director' AND role = 'director'
   AND model = 'claude-fable-5-2' AND effort IS NOT DISTINCT FROM 'medium';
