-- Remove the old HTTP-based cron job and replace with direct SQL call
SELECT cron.unschedule('cleanup-ai-users-weekly');

-- Re-schedule: calls cleanup_ai_users() directly, no HTTP needed
SELECT cron.schedule(
  'cleanup-ai-users-weekly',
  '0 3 * * 0',
  'SELECT cleanup_ai_users()'
);
