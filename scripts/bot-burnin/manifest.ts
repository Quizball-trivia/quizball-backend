/**
 * Run manifest + canonical fixture identity.
 *
 * Finding 4: a fixture id must identify the FIXTURE, not `seed + ordinal`. The
 * run manifest hashes every input that could change the plan (seed, season,
 * run date, target, margin, ceiling, params version, env, and the exact roster
 * with its loaded starting state). Each fixture key then hashes the manifest
 * hash together with the canonical fixture CONTENT (both participants, planned
 * timestamps, winner, decision, scores). On resume, an existing DB row is
 * accepted only after a field-by-field match against this canonical content —
 * a changed roster/config/runDate yields different keys, so a UUID can never
 * silently represent a different fixture.
 */
import { createHash } from 'node:crypto';
import type { BurnInBot, PlannedFixture } from './types.js';

export interface RunManifest {
  version: 1;
  seed: number;
  env: string;
  seasonStart: string;
  runDate: string;
  targetMatches: number;
  ceilingMarginRp: number;
  ceilingRp: number;
  humanTop10Rp: number | null;
  paramsGeneratedAt: string;
  paramsBatchId: string;
  /** The roster + its loaded starting state, canonicalized + sorted. */
  roster: Array<{
    userId: string;
    baseSkill: number;
    dailyCap: number;
    status: string;
    rp: number;
    placementPlayed: number;
    placementWins: number;
    placementStatus: string;
    currentWinStreak: number;
  }>;
  categoryIds: string[];
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function buildManifest(opts: {
  seed: number;
  env: string;
  seasonStart: Date;
  runDate: Date;
  targetMatches: number;
  ceilingMarginRp: number;
  ceilingRp: number;
  humanTop10Rp: number | null;
  paramsGeneratedAt: string;
  paramsBatchId: string;
  bots: BurnInBot[];
  categoryIds: string[];
}): RunManifest {
  return {
    version: 1,
    seed: opts.seed,
    env: opts.env,
    seasonStart: opts.seasonStart.toISOString(),
    runDate: opts.runDate.toISOString(),
    targetMatches: opts.targetMatches,
    ceilingMarginRp: opts.ceilingMarginRp,
    ceilingRp: opts.ceilingRp,
    humanTop10Rp: opts.humanTop10Rp,
    paramsGeneratedAt: opts.paramsGeneratedAt,
    paramsBatchId: opts.paramsBatchId,
    roster: [...opts.bots]
      .map((b) => ({
        userId: b.userId,
        baseSkill: b.baseSkill,
        dailyCap: b.dailyCap,
        status: b.status,
        rp: b.rp,
        placementPlayed: b.placementPlayed,
        placementWins: b.placementWins,
        placementStatus: b.placementStatus,
        currentWinStreak: b.currentWinStreak,
      }))
      .sort((a, b) => (a.userId < b.userId ? -1 : 1)),
    categoryIds: [...opts.categoryIds].sort(),
  };
}

export function manifestHash(manifest: RunManifest): string {
  return createHash('sha256').update(stableStringify(manifest)).digest('hex');
}

/** Canonical content that uniquely identifies a fixture within a run. */
export function fixtureContentDigest(manifestHashHex: string, fixture: {
  botAUserId: string;
  botBUserId: string;
  startedAt: Date;
  endedAt: Date;
  winnerUserId: string;
  decision: string;
  scoreA: PlannedFixture['scoreA'];
  scoreB: PlannedFixture['scoreB'];
}): string {
  const canonical = stableStringify({
    m: manifestHashHex,
    a: fixture.botAUserId,
    b: fixture.botBUserId,
    s: fixture.startedAt.toISOString(),
    e: fixture.endedAt.toISOString(),
    w: fixture.winnerUserId,
    d: fixture.decision,
    sa: fixture.scoreA,
    sb: fixture.scoreB,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** A v4-shaped UUID derived from the fixture content digest (stable id). */
export function fixtureMatchIdFromDigest(digestHex: string): string {
  const h = digestHex;
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-` +
    `${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
  );
}
