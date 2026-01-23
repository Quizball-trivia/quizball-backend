-- Rollback: Initial schema
-- Run this manually to undo the initial migration

-- Drop triggers first
DROP TRIGGER IF EXISTS trg_users_set_updated_at ON users;

-- Drop trigger function
DROP FUNCTION IF EXISTS trigger_set_updated_at();

-- Drop tables (order matters due to foreign keys)
DROP TABLE IF EXISTS user_identities;
DROP TABLE IF EXISTS users;
