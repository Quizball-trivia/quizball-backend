-- Track the maximum achievable score for each daily challenge session so
-- completion payouts can clamp client-reported scores without full re-grading.

CREATE TABLE IF NOT EXISTS daily_challenge_sessions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_type TEXT NOT NULL,
  challenge_day DATE NOT NULL,
  max_score INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_daily_challenge_sessions PRIMARY KEY (user_id, challenge_type, challenge_day),
  CONSTRAINT chk_daily_challenge_session_type CHECK (
    challenge_type IN (
      'moneyDrop',
      'trueFalse',
      'clues',
      'countdown',
      'putInOrder',
      'imposter',
      'careerPath',
      'highLow',
      'footballLogic'
    )
  ),
  CONSTRAINT chk_daily_challenge_session_max_score CHECK (max_score >= 0)
);

DROP TRIGGER IF EXISTS trg_daily_challenge_sessions_set_updated_at ON daily_challenge_sessions;
CREATE TRIGGER trg_daily_challenge_sessions_set_updated_at
  BEFORE UPDATE ON daily_challenge_sessions
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();
