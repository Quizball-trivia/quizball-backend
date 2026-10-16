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
  const [row] = await sql<{ registered_members: number; partner_players?: number; partner_players_by_partner?: Record<string, number>;
    registered_members_by_signup_platform?: Record<string, number>;
    unlinked_played_guest_journeys?: number;
    played_guests_by_first_platform?: Record<string, number>;
    signup_platform_daily_30d?: Array<{ day: string; platform: string; accounts: number }> }[]>`
    WITH people AS (
      SELECT u.id, u.partner_slug, u.role, coalesce(a.platform, 'unknown') AS signup_platform
      FROM users u
      LEFT JOIN user_signup_attribution a ON a.user_id = u.id
      WHERE coalesce(u.is_ai, false) = false
        AND coalesce(u.is_seed, false) = false
        AND coalesce(u.is_guest, false) = false
        AND coalesce(u.is_deleted, false) = false
        AND u.deleted_at IS NULL
    ), unlinked_guests AS (
      SELECT coalesce(first_play_platform, 'unknown') AS platform
      FROM guest_journeys WHERE first_play_at IS NOT NULL AND linked_at IS NULL
    )
    SELECT
      (SELECT count(*)::integer FROM people WHERE partner_slug IS NULL AND role <> 'partner_staff') AS registered_members,
      (SELECT count(*)::integer FROM people WHERE partner_slug IS NOT NULL) AS partner_players,
      (SELECT coalesce(jsonb_object_agg(partner_slug, n), '{}'::jsonb)
         FROM (SELECT partner_slug, count(*)::integer AS n FROM people WHERE partner_slug IS NOT NULL GROUP BY partner_slug) p
      ) AS partner_players_by_partner,
      (SELECT coalesce(jsonb_object_agg(signup_platform, n), '{}'::jsonb)
         FROM (SELECT signup_platform, count(*)::integer AS n FROM people
               WHERE partner_slug IS NULL AND role <> 'partner_staff' GROUP BY signup_platform) p
      ) AS registered_members_by_signup_platform,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('day', day, 'platform', platform, 'accounts', n)
                                ORDER BY day, platform), '[]'::jsonb)
         FROM (SELECT to_char(a.recorded_at AT TIME ZONE 'Asia/Tbilisi', 'YYYY-MM-DD') AS day,
                      a.platform, count(*)::integer AS n
               FROM user_signup_attribution a JOIN people p ON p.id = a.user_id
               WHERE p.partner_slug IS NULL AND p.role <> 'partner_staff'
                 AND a.recorded_at >= now() - INTERVAL '30 days'
               GROUP BY day, a.platform) d
      ) AS signup_platform_daily_30d,
      (SELECT count(*)::integer FROM unlinked_guests) AS unlinked_played_guest_journeys,
      (SELECT coalesce(jsonb_object_agg(platform, n), '{}'::jsonb)
        FROM (SELECT platform, count(*)::integer AS n FROM unlinked_guests GROUP BY platform) g
      ) AS played_guests_by_first_platform`;
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
      registered_members_by_signup_platform: row.registered_members_by_signup_platform ?? {},
      signup_platform_daily_30d: row.signup_platform_daily_30d ?? [],
      signup_platform_schema_version: 1,
      unlinked_played_guest_journeys: row.unlinked_played_guest_journeys ?? 0,
      played_guests_by_first_platform: row.played_guests_by_first_platform ?? {},
      users_including_played_guests: row.registered_members + (row.unlinked_played_guest_journeys ?? 0),
      guest_platform_schema_version: 1,
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
