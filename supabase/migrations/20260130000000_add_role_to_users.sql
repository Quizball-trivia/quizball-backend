-- Add role column to users table for role-based authorization
-- 'admin' - CMS users who can create/update/delete content
-- 'user' - Regular mobile app users who can only read content

ALTER TABLE users
ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
CHECK (role IN ('admin', 'user'));

-- Create index for role lookups
CREATE INDEX idx_users_role ON users(role);
