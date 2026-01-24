-- Add index on questions.status for filtering queries
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
