/** Stored versions of the Freecroco ranked points table (contract §7.1). A version row never changes once written,
 *  so a version read is cached for the life of the process; only "which version is current" can move. */

import { sql } from '../../../../db/index.js';
import type { Db } from '../../partner-db.js';
import { DEFAULT_RANKED_POINTS, rankedMaxScore, type RankedPointsTable } from './ranked-points.js';

/** The version every partner starts on (the contract's table); entries attached before versions existed use it. */
export const FIRST_RANKED_POINTS_VERSION = 1;

interface PartnerRef {
  slug: string;
  environment: string;
}

export interface RankedPointsRow {
  version: number;
  margin_winner: number[];
  margin_loser: number[];
  penalty_winner: number;
  penalty_loser: number;
  draw_after_penalties: number;
  left_not_ahead: number;
}

export function tableFromRow(row: RankedPointsRow): RankedPointsTable {
  return {
    margins: row.margin_winner.map((winner, i) => ({ winner, loser: row.margin_loser[i]! })),
    penaltyWin: { winner: row.penalty_winner, loser: row.penalty_loser },
    drawAfterPenalties: row.draw_after_penalties,
    leftNotAhead: row.left_not_ahead,
  };
}

const byVersion = new Map<string, RankedPointsTable>();
const versionKey = (partner: PartnerRef, version: number) => `${partner.slug}|${partner.environment}|${version}`;

/** One stored version (immutable). `db` lets settlement read inside its own transaction on a cache miss. */
export async function rankedPointsVersion(partner: PartnerRef, version: number, db: Db = sql): Promise<RankedPointsTable> {
  const key = versionKey(partner, version);
  const cached = byVersion.get(key);
  if (cached) return cached;
  const [row] = await db<RankedPointsRow[]>`
    SELECT version, margin_winner, margin_loser, penalty_winner, penalty_loser, draw_after_penalties, left_not_ahead
    FROM partner_ranked_points
    WHERE partner_slug = ${partner.slug} AND environment = ${partner.environment} AND version = ${version}`;
  if (!row) throw new Error(`Ranked points version ${version} is missing for ${partner.slug}/${partner.environment}`);
  const table = tableFromRow(row);
  byVersion.set(key, table);
  return table;
}

/** How long a replica keeps showing the old "up to" after another replica saved a new table (display only). */
const CURRENT_TTL_MS = 30_000;
const current = new Map<string, { maxScore: number; expiresAt: number }>();

/** The per-play maximum under the table in force now (the ranked tile's "up to"). */
export async function currentRankedMaxScore(partner: PartnerRef): Promise<number> {
  const key = `${partner.slug}|${partner.environment}`;
  const hit = current.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.maxScore;
  const [row] = await sql<{ version: number }[]>`
    SELECT ranked_points_version AS version FROM partner_config_versions
    WHERE partner_slug = ${partner.slug} AND environment = ${partner.environment}`;
  const maxScore = rankedMaxScore(
    row ? await rankedPointsVersion(partner, row.version) : DEFAULT_RANKED_POINTS,
  );
  current.set(key, { maxScore, expiresAt: Date.now() + CURRENT_TTL_MS });
  return maxScore;
}

/** After a save on this replica, so its own next read is fresh. */
export function forgetCurrentRankedPoints(partner: PartnerRef): void {
  current.delete(`${partner.slug}|${partner.environment}`);
}

/** Test hook only. */
export function resetRankedPointsCache(): void {
  byVersion.clear();
  current.clear();
}
