/**
 * The MANIFEST is the single canonical input to the creation script (finding
 * #1). It binds, in one signed-by-hash object, everything that determines the
 * roster that will be written:
 *   - reportSha256   : the human-approved dry-run report bytes
 *   - patternsSha256 : the exact patterns.json used
 *   - exclusionSha256: the frozen exclusion snapshot
 *   - seed + count   : generation inputs
 *   - rosterSha256   : a digest of ALL `count` generated rows, canonicalized
 *
 * create.ts regenerates the roster from (seed, count, patterns) and REFUSES to
 * run unless the regenerated rosterSha256 matches the manifest AND the report
 * bytes hash to manifest.reportSha256. There are no independent --patterns /
 * --count inputs: the manifest is authoritative, so an approved report can never
 * be paired with different patterns or a different count.
 */

import { createHash } from 'node:crypto';

import type { GeneratedBot } from './roster.js';

export interface RosterManifest {
  schemaVersion: 2;
  seed: number;
  count: number;
  reportSha256: string;
  patternsSha256: string;
  exclusionSha256: string;
  rosterSha256: string;
  generatedAt: string;
  maxNameAttempts: number;
}

/**
 * Canonicalize one bot to a stable, order-independent string. Every field that
 * is written to the DB is included, so the digest changes if ANY generated value
 * changes. bigint is stringified; object keys are sorted.
 */
function canonicalizeBot(b: GeneratedBot): string {
  const affinities = Object.keys(b.categoryAffinities)
    .sort()
    .map((k) => `${k}=${b.categoryAffinities[k]}`)
    .join(',');
  const avatar = b.avatarCustomization
    ? Object.entries(b.avatarCustomization as unknown as Record<string, string>)
        .sort(([a], [c]) => a.localeCompare(c))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
    : '';
  return [
    b.index,
    b.nickname,
    b.country,
    b.homeCity ?? '',
    b.homeLat ?? '',
    b.homeLng ?? '',
    b.favoriteClub ?? '',
    avatar,
    b.personalitySeed.toString(),
    b.baseSkill,
    b.skillBand,
    b.consistency,
    b.speedOffset,
    affinities,
    `${b.schedule.archetype}:${b.schedule.startHour}-${b.schedule.endHour}:${b.schedule.sessionLength[0]}-${b.schedule.sessionLength[1]}`,
    b.dailyCap,
    b.renamePropensity,
    b.willRename ? '1' : '0',
  ].join('|');
}

/** Deterministic digest over the FULL roster (all rows, in index order). */
export function rosterDigest(bots: GeneratedBot[]): string {
  const h = createHash('sha256');
  for (const b of bots) h.update(canonicalizeBot(b) + '\n');
  return h.digest('hex');
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}
