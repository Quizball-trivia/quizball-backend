import { getPostHogClient, stableAnalyticsEventUuid } from '../../core/analytics.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | undefined;
let pending: Promise<void> | undefined;

/** Send the current environment's database account count without creating a PostHog person. */
export async function publishRegisteredMemberCountSnapshot(now = new Date()): Promise<void> {
  if (config.NODE_ENV !== 'prod' && config.NODE_ENV !== 'staging') return;
  const client = getPostHogClient();
  if (!client) return;

  const [row] = await sql<{ registered_members: number }[]>`
    SELECT count(*)::integer AS registered_members
    FROM users
    WHERE coalesce(is_ai, false) = false
      AND coalesce(is_seed, false) = false
      AND coalesce(is_guest, false) = false
      AND coalesce(is_deleted, false) = false
      AND deleted_at IS NULL`;
  if (!row) throw new Error('Registered-member count query returned no row');

  // Replicas use the same event identity for a five-minute bucket. A retry or
  // rolling deploy cannot double-count the snapshot.
  const bucket = new Date(Math.floor(now.getTime() / SNAPSHOT_INTERVAL_MS) * SNAPSHOT_INTERVAL_MS);
  await client.captureImmediate({
    distinctId: 'quizball:registered-member-count',
    event: 'registered_member_count_snapshot',
    uuid: stableAnalyticsEventUuid(`registered-member-count:${bucket.toISOString()}`),
    timestamp: bucket,
    properties: {
      registered_members: row.registered_members,
      counted_at: now.toISOString(),
      source: `${config.NODE_ENV}.users`,
      environment: config.NODE_ENV,
      event_source: 'server',
      $process_person_profile: false,
      $geoip_disable: true,
    },
  });
}

export function startRegisteredMemberCountWorker(): void {
  if (timer || (config.NODE_ENV !== 'prod' && config.NODE_ENV !== 'staging') || !process.env.POSTHOG_API_KEY) return;
  const run = () => {
    if (pending) return;
    pending = publishRegisteredMemberCountSnapshot()
      .catch((error) => logger.warn({ error }, 'Registered-member count snapshot failed'))
      .finally(() => { pending = undefined; });
  };
  run();
  timer = setInterval(run, SNAPSHOT_INTERVAL_MS);
  timer.unref();
}

export async function stopRegisteredMemberCountWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await pending;
}
