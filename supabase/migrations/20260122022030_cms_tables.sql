-- =============================================================================
-- Migration: Create CMS Tables (Categories & Questions)
-- Description: Creates tables for content management - categories, featured_categories,
--              questions, and question_payloads with i18n support
-- =============================================================================

-- =============================================================================
-- Categories table
-- =============================================================================
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  parent_id UUID REFERENCES categories(id) ON DELETE SET NULL,

  -- i18n fields (JSONB)
  name JSONB NOT NULL,
  description JSONB,

  -- Display
  icon TEXT,
  image_url TEXT,

  -- Settings
  is_active BOOLEAN NOT NULL DEFAULT true,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index: parent_id for hierarchy queries
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

-- Trigger: auto-update updated_at
DROP TRIGGER IF EXISTS trg_categories_set_updated_at ON categories;
CREATE TRIGGER trg_categories_set_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- Featured Categories table
-- Categories in this table appear in "For You" horizontal section
-- Only stores reference + sort order (no data duplication)
-- =============================================================================
CREATE TABLE IF NOT EXISTS featured_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID UNIQUE NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Questions table
-- Note: time_limit and points belong to game_modes, not here
-- =============================================================================
CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,

  -- Question metadata
  type TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',

  -- i18n fields (JSONB)
  prompt JSONB NOT NULL,
  explanation JSONB,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT chk_questions_difficulty CHECK (difficulty IN ('easy', 'medium', 'hard')),
  CONSTRAINT chk_questions_status CHECK (status IN ('draft', 'published', 'archived'))
);

-- Index: category_id for "get questions by category" queries
CREATE INDEX IF NOT EXISTS idx_questions_category ON questions(category_id);

-- Index: category + status for "get published questions in category"
CREATE INDEX IF NOT EXISTS idx_questions_category_status ON questions(category_id, status);

-- Trigger: auto-update updated_at
DROP TRIGGER IF EXISTS trg_questions_set_updated_at ON questions;
CREATE TRIGGER trg_questions_set_updated_at
  BEFORE UPDATE ON questions
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- Question Payloads table
-- Stores type-specific structure (options, answers) as JSONB
-- One-to-one relationship with questions
-- =============================================================================
CREATE TABLE IF NOT EXISTS question_payloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID UNIQUE NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger: auto-update updated_at
DROP TRIGGER IF EXISTS trg_payloads_set_updated_at ON question_payloads;
CREATE TRIGGER trg_payloads_set_updated_at
  BEFORE UPDATE ON question_payloads
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();
