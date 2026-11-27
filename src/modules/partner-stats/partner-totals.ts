import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { TABLE_DERBY, tbilisiDay } from './partner-days.js';

/**
 * The partner part of every Quizball "total users" figure (admin-stats, the
 * CMS user total, HQ): one reader of partner_daily_stats for all of them.
 */

export interface PartnerDayRow {
  day: string;
  total_users: number;
  new_users: number;
  active_users: number;
  active_7d: number;
  active_30d: number;
  matches: number;
  updated_at: string;
}

export interface PartnerSnapshot {
  /** The latest synced Tbilisi day: the totals and actives are that day's. */
  day: string;
  updatedAt: string;
  totalUsers: number;
  newUsers: number;
  dau: number;
  wau: number;
  mau: number;
  matches: number;
  /** Synced days from the requested first day, oldest first. */
  days: { day: string; newUsers: number; activeUsers: number; matches: number }[];
}

/** Rows read per request: back to the first day asked for, plus a few for a latest day before it. */
const MIN_ROWS = 40;
const MAX_ROWS = 400;
const rowsFor = (firstDay: string, now: Date) => {
  const back = Math.round((Date.parse(`${tbilisiDay(now)}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000);
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, back + 5));
};
/** The last rows read per partner and row count, for reuse when a read fails. */
const lastGood = new Map<string, Map<number, PartnerDayRow[]>>();

export const partnerStatsRepo = {
  async latestDays(partner: string, limit: number): Promise<PartnerDayRow[]> {
    return sql<PartnerDayRow[]>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, total_users, new_users, active_users, active_7d, active_30d,
             matches, updated_at
      FROM partner_daily_stats
      WHERE partner = ${partner}
      ORDER BY day DESC
      LIMIT ${limit}
    `;
  },
};

export function toSnapshot(rows: readonly PartnerDayRow[], firstDay: string): PartnerSnapshot | null {
  const latest = rows[0];
  if (!latest) return null;
  return {
    day: latest.day,
    updatedAt: new Date(latest.updated_at).toISOString(),
    totalUsers: latest.total_users,
    newUsers: latest.new_users,
    dau: latest.active_users,
    wau: latest.active_7d,
    mau: latest.active_30d,
    matches: latest.matches,
    days: rows
      .filter((r) => r.day >= firstDay)
      .reverse()
      .map((r) => ({ day: r.day, newUsers: r.new_users, activeUsers: r.active_users, matches: r.matches })),
  };
}

/**
 * A partner's latest synced counts and its days from `firstDay` on; null only
 * when nothing has been synced yet. A failed read reuses the last rows read on
 * this replica, and fails only when there are none (a smaller total is never
 * shown as if it were complete).
 */
export async function readPartnerSnapshot(
  firstDay: string,
  partner = TABLE_DERBY,
  now = new Date(),
): Promise<PartnerSnapshot | null> {
  const limit = rowsFor(firstDay, now);
  let rows: PartnerDayRow[];
  try {
    rows = [...(await partnerStatsRepo.latestDays(partner, limit))];
    let kept = lastGood.get(partner);
    if (!kept) lastGood.set(partner, (kept = new Map()));
    kept.set(limit, rows);
  } catch (error) {
    const kept = coveringRows(lastGood.get(partner), limit, firstDay);
    const code = (error as { code?: unknown } | null)?.code;
    logger.warn({ partner, code: typeof code === 'string' ? code : 'unknown', reused: Boolean(kept) },
      'Partner daily stats unreadable');
    if (!kept) throw error;
    rows = kept;
  }
  return toSnapshot(rows, firstDay);
}

/**
 * Kept rows that answer a request for `limit` rows from `firstDay`: a read of
 * at least as many rows, or one that reached back to `firstDay` or held every
 * synced day. The freshest such read wins (the newest latest day).
 */
function coveringRows(
  kept: Map<number, PartnerDayRow[]> | undefined,
  limit: number,
  firstDay: string,
): PartnerDayRow[] | undefined {
  let best: PartnerDayRow[] | undefined;
  for (const [readLimit, rows] of kept ?? []) {
    const oldest = rows[rows.length - 1]?.day;
    const covers = readLimit >= limit || rows.length < readLimit || (oldest !== undefined && oldest <= firstDay);
    if (covers && (!best || (rows[0]?.day ?? '') > (best[0]?.day ?? ''))) best = rows;
  }
  return best;
}

export function forgetPartnerSnapshotsForTests(): void {
  lastGood.clear();
}
