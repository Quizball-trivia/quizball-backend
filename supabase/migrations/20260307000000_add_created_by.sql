-- Add created_by column to questions and categories for tracking content attribution
-- ============================================================================

-- Add created_by to questions
ALTER TABLE questions ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Add created_by to categories
ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Indexes for efficient activity queries
CREATE INDEX IF NOT EXISTS idx_questions_created_by ON questions(created_by);
CREATE INDEX IF NOT EXISTS idx_categories_created_by ON categories(created_by);
CREATE INDEX IF NOT EXISTS idx_questions_created_at_created_by ON questions(created_at, created_by);
CREATE INDEX IF NOT EXISTS idx_categories_created_at_created_by ON categories(created_at, created_by);

-- Backfill all existing rows to admin@quizball.com (LIMIT 1 to handle duplicate users)
UPDATE questions SET created_by = (SELECT id FROM users WHERE email = 'admin@quizball.com' ORDER BY created_at ASC LIMIT 1) WHERE created_by IS NULL;
UPDATE categories SET created_by = (SELECT id FROM users WHERE email = 'admin@quizball.com' ORDER BY created_at ASC LIMIT 1) WHERE created_by IS NULL;
