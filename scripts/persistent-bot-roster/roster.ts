/**
 * Deterministic roster generation. Pure (no I/O) so it is unit-testable and so
 * the creation script can rebuild the EXACT roster the report was approved for.
 *
 * Determinism contract:
 *   - One master seed (effective seed space 2^32 — see prng.ts). Each bot
 *     attribute draws from its OWN per-(bot,field) sub-stream (see prng.ts), so
 *     variable-length consumption in one attribute never shifts another — of the
 *     same or any other bot. No two attributes share a stream.
 *   - The name-generation `taken` set is the ONE intentional cross-bot
 *     dependency: an ordered pass i=0..N-1, each bot's name checked against the
 *     FROZEN exclusion set ∪ names emitted by earlier indices. Iteration order is
 *     fixed by index, so the whole sequence is reproducible. A golden-digest test
 *     (fixed seed → sha256 of the canonicalized roster) guards cross-version drift.
 */

import type { RosterPatterns, ScheduleArchetype } from './patterns.js';
import { COUNTRY_CITIES } from './pools.js';
import { buildCandidate } from './name-generator.js';
import { exclusionMembership, nfcLower } from './exclusion.js';
import {
  chance,
  fieldRng,
  personalitySeed,
  pick,
  quantileSample,
  randInt,
  weightedPick,
  type Rng,
} from './prng.js';

export interface AvatarCustomization {
  hair: string;
  jersey: string;
  skin: string;
  facialHair?: string;
  glasses?: string;
}

export interface GeneratedBot {
  index: number;
  nickname: string;
  country: string;
  homeCity: string | null;
  homeLat: number | null;
  homeLng: number | null;
  favoriteClub: string | null;
  avatarCustomization: AvatarCustomization | null;
  personalitySeed: bigint;
  baseSkill: number;
  skillBand: number; // 0..4 (bottom→top)
  consistency: number;
  speedOffset: number;
  categoryAffinities: Record<string, number>;
  schedule: {
    archetype: string;
    startHour: number;
    endHour: number;
    sessionLength: [number, number];
  };
  dailyCap: number;
  renamePropensity: number;
  willRename: boolean;
  /** Attempts the name generator needed (for the effective-space report). */
  nameAttempts: number;
}

export interface GenerateOptions {
  seed: number;
  count: number;
  patterns: RosterPatterns;
}

const MAX_NAME_ATTEMPTS = 40;

/** Minimum category count needed to sample 2-4 strengths + 2-4 weaknesses. */
const MIN_CATEGORIES = 8;

/**
 * Hard ceiling on a bot's matches-per-day cap, applied AFTER the archetype draw.
 * OVERRIDDEN vs measured: real prod players have a heavy tail (measured p99 ~34,
 * max ~120 matches/day) that we deliberately do NOT mimic — see the clamp site.
 */
export const DAILY_CAP_CEILING = 12;

/** Canonical case-insensitive key (shared with the exclusion hashing). */
function normalizeForExclusion(name: string): string {
  return nfcLower(name);
}

function generateName(
  masterSeed: number,
  index: number,
  patterns: RosterPatterns,
  isExcluded: (name: string) => boolean,
  emitted: Set<string>,
): { nickname: string; attempts: number } {
  const rng = fieldRng(masterSeed, index, 'name');
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = buildCandidate({ rng, patterns: patterns.name, attempt });
    const key = normalizeForExclusion(candidate);
    // Reject if empty, already emitted (mutual uniqueness), or in the frozen
    // exclusion set (tested against the salted-hash membership set — no plaintext).
    if (!key || emitted.has(key) || isExcluded(candidate)) continue;
    emitted.add(key);
    return { nickname: candidate, attempts: attempt + 1 };
  }
  throw new Error(
    `Failed to generate a unique nickname for bot #${index} after ${MAX_NAME_ATTEMPTS} attempts — ` +
      'the reachable name space is too small relative to the roster + exclusion set. ' +
      'Expand the curated pools.',
  );
}

function sampleAvatar(rng: Rng, patterns: RosterPatterns): AvatarCustomization | null {
  if (!chance(rng, patterns.avatar.presenceRate)) return null;
  const a = patterns.avatar;
  const av: AvatarCustomization = {
    hair: weightedPick(rng, a.hair.map((x) => x.value), a.hair.map((x) => x.weight)),
    jersey: weightedPick(rng, a.jersey.map((x) => x.value), a.jersey.map((x) => x.weight)),
    skin: weightedPick(rng, a.skin.map((x) => x.value), a.skin.map((x) => x.weight)),
  };
  if (a.facialHair.length > 0 && chance(rng, a.facialHairRate)) {
    av.facialHair = weightedPick(rng, a.facialHair.map((x) => x.value), a.facialHair.map((x) => x.weight));
  }
  if (a.glasses.length > 0 && chance(rng, a.glassesRate)) {
    av.glasses = weightedPick(rng, a.glasses.map((x) => x.value), a.glasses.map((x) => x.weight));
  }
  return av;
}

function sampleCountryCity(
  rng: Rng,
  patterns: RosterPatterns,
): { country: string; city: string | null; lat: number | null; lng: number | null } {
  const country = weightedPick(
    rng,
    patterns.country.distribution.map((x) => x.value),
    patterns.country.distribution.map((x) => x.weight),
  );
  const cities = COUNTRY_CITIES[country] ?? [];
  if (cities.length === 0) return { country, city: null, lat: null, lng: null };
  const c = pick(rng, cities);
  return { country, city: c.name, lat: c.lat, lng: c.lng };
}

function sampleSkillBand(rng: Rng, patterns: RosterPatterns): { band: number; baseSkill: number } {
  const weights = patterns.skill.bandWeights;
  const band = weightedPick(rng, weights.map((_, i) => i), weights);
  const [lo, hi] = patterns.skill.bandRanges[band]!;
  const baseSkill = lo + rng() * (hi - lo);
  return { band, baseSkill };
}

function sampleAffinities(rng: Rng, categories: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const shuffled = [...categories];
  // Fisher-Yates using the provided rng (fixed length => fixed draw count).
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const nStrength = randInt(rng, 2, 4);
  const nWeakness = randInt(rng, 2, 4);
  let k = 0;
  for (let s = 0; s < nStrength && k < shuffled.length; s++, k++) {
    out[shuffled[k]!] = +(0.05 + rng() * 0.15).toFixed(3); // +0.05..+0.20
  }
  for (let w = 0; w < nWeakness && k < shuffled.length; w++, k++) {
    out[shuffled[k]!] = +(-(0.05 + rng() * 0.15)).toFixed(3); // -0.05..-0.20
  }
  return out;
}

function sampleSchedule(rng: Rng, archetypes: ScheduleArchetype[]): ScheduleArchetype {
  return weightedPick(rng, archetypes, archetypes.map((a) => a.weight));
}

export function generateRoster(options: GenerateOptions): GeneratedBot[] {
  const { seed, count, patterns } = options;
  // Finding #5: affinities key on the FROZEN real category slugs from
  // patterns.json (hyphenated live slugs), never invented underscore names.
  const categories = patterns.categorySlugs ?? [];
  if (categories.length < MIN_CATEGORIES) {
    throw new Error(
      `patterns.json has only ${categories.length} category slugs; need >= ${MIN_CATEGORIES}. ` +
        'Re-run the measurement script against a DB with the real categories table.',
    );
  }

  // Frozen exclusion set: membership-tested against the committed SALTED HASHES
  // (no plaintext). `emitted` tracks names produced so far for mutual uniqueness.
  const { has: isExcluded } = exclusionMembership(patterns.exclusion);
  const emitted = new Set<string>();
  const bots: GeneratedBot[] = [];

  for (let i = 0; i < count; i++) {
    const { nickname, attempts } = generateName(seed, i, patterns, isExcluded, emitted);

    // Finding #7: EVERY attribute draws from its OWN sub-seeded stream, so
    // adding a draw to one attribute can never shift another (of this bot or any
    // other). The name-generation `taken` set is the ONE intentional cross-bot
    // dependency (documented in the module header).
    const avatarRng = fieldRng(seed, i, 'avatar');
    const geoRng = fieldRng(seed, i, 'geo');
    const clubRng = fieldRng(seed, i, 'club');
    const skillRng = fieldRng(seed, i, 'skill');
    const affinityRng = fieldRng(seed, i, 'affinity');
    const consistencyRng = fieldRng(seed, i, 'consistency');
    const speedOffsetRng = fieldRng(seed, i, 'speedOffset');
    const schedRng = fieldRng(seed, i, 'schedule');
    const capRng = fieldRng(seed, i, 'dailyCap');
    const renamePropensityRng = fieldRng(seed, i, 'renamePropensity');
    const willRenameRng = fieldRng(seed, i, 'willRename');

    const avatar = sampleAvatar(avatarRng, patterns);
    const { country, city, lat, lng } = sampleCountryCity(geoRng, patterns);
    const favoriteClub = chance(clubRng, patterns.club.nonNullRate)
      ? weightedPick(clubRng, patterns.club.distribution.map((x) => x.value), patterns.club.distribution.map((x) => x.weight))
      : null;
    const { band, baseSkill } = sampleSkillBand(skillRng, patterns);
    const affinities = sampleAffinities(affinityRng, categories);
    const consistency = +(0.35 + consistencyRng() * 0.5).toFixed(3); // 0.35..0.85
    const speedOffset = +((speedOffsetRng() - 0.5) * 0.6).toFixed(3); // -0.30..+0.30
    const archetype = sampleSchedule(schedRng, patterns.activity.scheduleArchetypes);
    // Cap is drawn JOINTLY with the archetype (finding #6): from THIS archetype's
    // own cap quantiles, so a night-owl can never get a 15-match cap.
    // Then clamped to DAILY_CAP_CEILING: the measured tail of real prod players
    // reaches 120 matches/day, but a cap is a worst-case ceiling on an
    // always-available synthetic identity, and a bot saturating dozens of matches
    // a day is conspicuous on the leaderboard and inflates matchmaking load. The
    // clamp keeps the realistic central mass and truncates only the tail.
    const dailyCap = Math.min(quantileSample(capRng, archetype.dailyCapQuantiles), DAILY_CAP_CEILING);
    const renamePropensity = +(patterns.rename.lifetimeRate * (0.5 + renamePropensityRng())).toFixed(3);
    const willRename = chance(willRenameRng, patterns.rename.lifetimeRate);

    bots.push({
      index: i,
      nickname,
      country,
      homeCity: city,
      homeLat: lat,
      homeLng: lng,
      favoriteClub,
      avatarCustomization: avatar,
      personalitySeed: personalitySeed(seed, i),
      baseSkill: +baseSkill.toFixed(3),
      skillBand: band,
      consistency,
      speedOffset,
      categoryAffinities: affinities,
      schedule: {
        archetype: archetype.key,
        startHour: archetype.startHour,
        endHour: archetype.endHour,
        sessionLength: archetype.sessionLength,
      },
      dailyCap,
      renamePropensity,
      willRename,
      nameAttempts: attempts,
    });
  }

  return bots;
}

export { normalizeForExclusion, MAX_NAME_ATTEMPTS };
