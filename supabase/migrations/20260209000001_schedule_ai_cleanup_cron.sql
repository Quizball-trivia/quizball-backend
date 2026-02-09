-- Enable pg_cron for scheduled jobs
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Unschedule any existing job to make this migration idempotent
SELECT cron.unschedule('cleanup-ai-users-weekly') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'cleanup-ai-users-weekly'
);

-- Schedule weekly cleanup: Sunday 3:00 AM UTC
-- Calls the cleanup_ai_users() function directly via SQL — no HTTP/edge function needed
SELECT cron.schedule(
  'cleanup-ai-users-weekly',
  '0 3 * * 0',
  'SELECT cleanup_ai_users()'
);
