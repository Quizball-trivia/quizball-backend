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

  // Members exclude partner players and partner staff; partner players are counted beside them (overall and per
  // partner), so dashboards can show Quizball users with or without them.
  const [row] = await sql<{ registered_members: number; partner_players?: number; partner_players_by_partner?: Record<string, number> }[]>`
    WITH people AS (
      SELECT partner_slug, role
      FROM users
      WHERE coalesce(is_ai, false) = false
        AND coalesce(is_seed, false) = false
        AND coalesce(is_guest, false) = false
        AND coalesce(is_deleted, false) = false
        AND deleted_at IS NULL
    )
    SELECT
      (SELECT count(*)::integer FROM people WHERE partner_slug IS NULL AND role <> 'partner_staff') AS registered_members,
      (SELECT count(*)::integer FROM people WHERE partner_slug IS NOT NULL) AS partner_players,
      (SELECT coalesce(jsonb_object_agg(partner_slug, n), '{}'::jsonb)
         FROM (SELECT partner_slug, count(*)::integer AS n FROM people WHERE partner_slug IS NOT NULL GROUP BY partner_slug) p
      ) AS partner_players_by_partner`;
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
      partner_players: row.partner_players ?? 0,
      partner_players_by_partner: row.partner_players_by_partner ?? {},
      users_including_partners: row.registered_members + (row.partner_players ?? 0),
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
