-- Minimal isolated fixture, NOT a production migration. Use only the guarded
-- 127.0.0.1:55519/rehearsal_analytics database for this release test.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, nickname text,
  phone_number text, phone_verified_at timestamptz, country text, avatar_url text,
  avatar_customization jsonb, onboarding_complete boolean NOT NULL DEFAULT false,
  is_ai boolean DEFAULT false, is_seed boolean DEFAULT false, is_guest boolean DEFAULT false,
  is_deleted boolean DEFAULT false, deleted_at timestamptz, pending_deletion_at timestamptz,
  partner_slug text, role text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_identities (
  id uuid PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL, subject text NOT NULL, email text, UNIQUE(provider, subject)
);
CREATE TABLE nickname_history (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  old_nickname text, new_nickname text, changed_by text,
  counted boolean, identity_derived boolean
);
