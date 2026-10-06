/** GET /partner/v1/status (contract v1.1 §5.6): api, database, realtime and score_delivery, measured at most every
 *  few seconds per process, each check bounded. score_delivery comes from the delivery stream through
 *  registerScoreDeliveryStatus and reports `unknown` until it is wired. */

import { sql } from '../../db/index.js';
import { getRedisClient } from '../../realtime/redis.js';

export type PartnerComponentStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface PartnerStatusComponent {
  name: string;
  status: PartnerComponentStatus;
  [detail: string]: unknown;
}

export interface PartnerStatusResponse {
  status: PartnerComponentStatus;
  checkedAt: string;
  components: PartnerStatusComponent[];
}

export interface ScoreDeliveryObservation {
  status: Exclude<PartnerComponentStatus, 'unknown'>;
  pending: number;
  oldestPendingSeconds: number;
  /** When the observation was measured; older than STALE_MS reports unknown. */
  measuredAt: Date;
}

const CACHE_MS = 5_000;
const CHECK_TIMEOUT_MS = 2_000;
export const STALE_MS = 2 * 60_000;

let scoreDelivery: (() => Promise<ScoreDeliveryObservation>) | null = null;

/** The delivery stream's backlog measurement (pending count, oldest age). */
export function registerScoreDeliveryStatus(provider: (() => Promise<ScoreDeliveryObservation>) | null): void {
  scoreDelivery = provider;
  cached = null;
}

async function bounded<T>(work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`check took over ${CHECK_TIMEOUT_MS} ms`)), CHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function database(): Promise<PartnerStatusComponent> {
  try {
    await bounded(async () => sql`SELECT 1`);
    return { name: 'database', status: 'ok' };
  } catch {
    return { name: 'database', status: 'down' };
  }
}

async function realtime(): Promise<PartnerStatusComponent> {
  const client = getRedisClient();
  if (!client?.isReady) return { name: 'realtime', status: 'down' };
  try {
    await bounded(() => client.ping());
    return { name: 'realtime', status: 'ok' };
  } catch {
    return { name: 'realtime', status: 'down' };
  }
}

async function delivery(now: Date): Promise<PartnerStatusComponent> {
  if (!scoreDelivery) return { name: 'score_delivery', status: 'unknown' };
  try {
    const seen = await bounded(scoreDelivery);
    if (now.getTime() - seen.measuredAt.getTime() > STALE_MS) return { name: 'score_delivery', status: 'unknown' };
    return { name: 'score_delivery', status: seen.status, pending: seen.pending, oldestPendingSeconds: seen.oldestPendingSeconds };
  } catch {
    return { name: 'score_delivery', status: 'unknown' };
  }
}

// The overall status is the worst component, an unknown one counting as degraded (contract §5.6).
const SEVERITY: Record<PartnerComponentStatus, number> = { ok: 0, degraded: 1, unknown: 1, down: 2 };

export function overallStatus(components: PartnerStatusComponent[]): Exclude<PartnerComponentStatus, 'unknown'> {
  const worst = Math.max(0, ...components.map((c) => SEVERITY[c.status]));
  return worst === 2 ? 'down' : worst === 1 ? 'degraded' : 'ok';
}

let cached: { at: number; value: Promise<PartnerStatusResponse> } | null = null;

export function partnerStatus(): Promise<PartnerStatusResponse> {
  const nowMs = Date.now();
  if (cached && nowMs - cached.at < CACHE_MS) return cached.value;
  const value = (async () => {
    const now = new Date();
    const components: PartnerStatusComponent[] = [
      { name: 'api', status: 'ok' },
      ...(await Promise.all([database(), realtime(), delivery(now)])),
    ];
    return { status: overallStatus(components), checkedAt: now.toISOString(), components };
  })();
  cached = { at: nowMs, value };
  return value;
}
