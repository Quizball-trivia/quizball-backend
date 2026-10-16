-- ONLY the isolated local 127.0.0.1:55519/rehearsal_analytics fixture.
-- Apply before the existing guest-journey migration and the new platform migration.
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
   CREATE ROLE service_role NOLOGIN;
 END IF;
END $$;
CREATE TABLE guest_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text UNIQUE, locale text,
 created_at timestamptz DEFAULT now(), last_seen_at timestamptz DEFAULT now(),
 linked_user_id uuid REFERENCES users(id) ON DELETE SET NULL
);
