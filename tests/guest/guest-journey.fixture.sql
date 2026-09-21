-- Run ONLY in a newly created local quizball_guest_journey_* database.
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, phone_number text, phone_verified_at timestamptz,
 nickname text, country text, avatar_url text, avatar_customization jsonb, onboarding_complete boolean default false,
 is_guest boolean default false, is_ai boolean default false, is_seed boolean default false,
 is_deleted boolean default false, deleted_at timestamptz, pending_deletion_at timestamptz
);
CREATE TABLE user_identities (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id), provider text, subject text, email text, UNIQUE(provider,subject));
CREATE TABLE nickname_history (user_id uuid REFERENCES users(id), old_nickname text, new_nickname text, changed_by text, counted boolean, identity_derived boolean);
CREATE TABLE guest_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text UNIQUE, locale text,
 created_at timestamptz default now(), last_seen_at timestamptz default now(), linked_user_id uuid REFERENCES users(id));
