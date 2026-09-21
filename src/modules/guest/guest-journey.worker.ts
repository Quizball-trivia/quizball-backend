import { sql } from '../../db/index.js';
import { getPostHogClient } from '../../core/analytics.js';
import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
let timer: ReturnType<typeof setInterval> | undefined;
let pending: Promise<void> | undefined;
/** Durable delivery, bounded batches, cross-replica leases, stable UUID + time on every retry. */
export async function deliverGuestJourneyEvents(): Promise<void> {
  const client = getPostHogClient();
  if (!client || config.NODE_ENV !== 'prod') return;
  const rows = await sql<{ id: string; guest_id: string; event: string; properties: Record<string, unknown>; occurred_at: string }[]>`
    UPDATE guest_journey_events SET lease_until = now() + interval '5 minutes', attempts = attempts + 1
    WHERE id IN (SELECT id FROM guest_journey_events WHERE delivered_at IS NULL AND next_attempt_at <= now()
      AND (lease_until IS NULL OR lease_until < now()) ORDER BY occurred_at LIMIT 20 FOR UPDATE SKIP LOCKED)
    RETURNING id, guest_id, event, properties, occurred_at`;
  for (const row of rows) {
    try {
      await client.captureImmediate({ distinctId: `guest-journey:${row.guest_id}`, event: row.event,
        uuid: row.id, timestamp: new Date(row.occurred_at), properties: { ...row.properties,
          environment: 'production', event_source: 'server', $process_person_profile: false, $geoip_disable: true,
        } });
      await sql`UPDATE guest_journey_events SET delivered_at = now(), lease_until = NULL WHERE id = ${row.id}`;
    } catch (error) {
      await sql`UPDATE guest_journey_events SET lease_until = NULL,
        next_attempt_at = now() + interval '1 minute' * least(attempts, 60) WHERE id = ${row.id}`;
      logger.warn({ eventId: row.id, error }, 'Guest journey delivery pending retry');
    }
  }
}
export function startGuestJourneyWorker(): void {
  if (timer || config.NODE_ENV !== 'prod' || !process.env.POSTHOG_API_KEY) return;
  timer = setInterval(() => {
    if (pending) return;
    pending = deliverGuestJourneyEvents().catch(error => logger.warn({ error }, 'Guest journey worker failed'))
      .finally(() => { pending = undefined; });
  }, 10_000);
  timer.unref();
}
export async function stopGuestJourneyWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await pending;
}
