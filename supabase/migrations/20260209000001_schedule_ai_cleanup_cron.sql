-- Enable pg_cron for scheduled jobs
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule weekly cleanup: Sunday 3:00 AM UTC
-- Calls the cleanup_ai_users() function directly — no HTTP/edge function needed
SELECT cron.schedule(
  'cleanup-ai-users-weekly',
  '0 3 * * 0',
  'SELECT cleanup_ai_users()'
);
