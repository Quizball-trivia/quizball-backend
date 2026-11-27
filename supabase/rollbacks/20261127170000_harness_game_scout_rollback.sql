DELETE FROM harness.jobs WHERE agent_slug = 'game-scout' AND kind = 'report';
DELETE FROM harness.reports WHERE agent_slug = 'game-scout';
DELETE FROM harness.agents WHERE slug = 'game-scout' AND NOT EXISTS (SELECT 1 FROM harness.runs WHERE agent_slug = 'game-scout');
