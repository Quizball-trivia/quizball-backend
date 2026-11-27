-- The Game Scout (HQ, straight to prod): every week it reads how each game did and proposes the one change most
-- likely to help each weak one. It writes a report for the Games department; a person turns a proposal into a
-- change request. It never changes a game.
INSERT INTO harness.agents (slug, name, team, description, provider, model, effort, primary_account, fallback_accounts, max_turns, timeout_ms)
VALUES ('game-scout', 'Game Scout', 'suggesting',
        'Reads how every game did this week and proposes the one change most likely to help each weak one, with the numbers behind it. A person picks what gets planned.',
        'claude', 'claude-opus-5-5', NULL, 'claude-premium-4',
        ARRAY['claude-premium-3', 'claude-ultra', 'claude-premium-1', 'claude-premium-5', 'claude-premium-2'], 8, 480000)
ON CONFLICT (slug) DO NOTHING;
