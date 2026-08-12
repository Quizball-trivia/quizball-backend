-- Track which daily-challenge questions each user was recently served so
-- session generation can prefer unseen questions. Service-role only.

CREATE TABLE IF NOT EXISTS daily_challenge_served_questions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  -- Normalized display-answer keys SNAPSHOTTED at serve time: history must not
  -- be rewritten by later payload edits, and needs no payload join to read.
  answer_keys TEXT[] NOT NULL DEFAULT '{}',
  served_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_challenge_served_questions_user_served_at
  ON daily_challenge_served_questions (user_id, served_at DESC);

-- Retention scan for the nightly prune (covers users who never return).
CREATE INDEX IF NOT EXISTS idx_daily_challenge_served_questions_served_at
  ON daily_challenge_served_questions (served_at);

ALTER TABLE daily_challenge_served_questions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON daily_challenge_served_questions FROM anon, authenticated;

SELECT cron.schedule(
  'prune-daily-challenge-served-questions',
  '20 2 * * *',
  $$DELETE FROM daily_challenge_served_questions WHERE served_at < NOW() - INTERVAL '60 days'$$
);
