-- The CMS question search uses trigram GIN indexes for substring matching.
-- Keep extension creation in its own transactional migration because each
-- online index build must be sent as a standalone command.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
