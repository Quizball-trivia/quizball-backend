import { describe, it, expect } from 'vitest';

import { generateRoster, normalizeForExclusion } from '../../scripts/persistent-bot-roster/roster.js';
import { fieldRng, mulberry32, personalitySeed, quantileSample, weightedPick } from '../../scripts/persistent-bot-roster/prng.js';
import { makePatterns } from './fixtures.js';

describe('roster generator — determinism', () => {
  it('same seed produces the identical roster', () => {
    const patterns = makePatterns();
    const a = generateRoster({ seed: 12345, count: 200, patterns });
    const b = generateRoster({ seed: 12345, count: 200, patterns });
    expect(a.length).toBe(200);
    expect(JSON.stringify(a, bigintReplacer)).toBe(JSON.stringify(b, bigintReplacer));
  });

  it('different seeds produce different rosters', () => {
    const patterns = makePatterns();
    const a = generateRoster({ seed: 1, count: 100, patterns });
    const b = generateRoster({ seed: 2, count: 100, patterns });
    expect(a.map((x) => x.nickname).join()).not.toBe(b.map((x) => x.nickname).join());
  });

  it('per-(bot,field) sub-seeding: bot i attributes depend only on (seed,i)', () => {
    const patterns = makePatterns();
    // Generating 50 vs 500 bots yields the SAME first 50 bots — no cross-bot drift.
    const short = generateRoster({ seed: 777, count: 50, patterns });
    const long = generateRoster({ seed: 777, count: 500, patterns });
    for (let i = 0; i < 50; i++) {
      expect(normalize(short[i]!)).toEqual(normalize(long[i]!));
    }
  });
});

describe('roster generator — uniqueness & exclusion', () => {
  it('all names mutually unique (case-insensitive)', () => {
    const bots = generateRoster({ seed: 42, count: 1000, patterns: makePatterns() });
    const keys = new Set(bots.map((b) => normalizeForExclusion(b.nickname)));
    expect(keys.size).toBe(1000);
  });

  it('never emits a name in the frozen exclusion set (case-insensitive)', () => {
    // Seed the exclusion set with names the generator would otherwise produce.
    const sample = generateRoster({ seed: 9, count: 300, patterns: makePatterns() });
    const excluded = sample.slice(0, 150).map((b) => normalizeForExclusion(b.nickname));
    const patterns = makePatterns({
      exclusion: { count: excluded.length, sha256: 'x', names: [...excluded].sort() },
    });
    const bots = generateRoster({ seed: 9, count: 300, patterns });
    for (const b of bots) {
      expect(excluded).not.toContain(normalizeForExclusion(b.nickname));
    }
  });

  it('still produces the full count under a large exclusion set', () => {
    // Exclude 5,000 plausible names; generator must still fill 1,000 uniquely.
    const filler = generateRoster({ seed: 555, count: 5000, patterns: makePatterns() });
    const names = filler.map((b) => normalizeForExclusion(b.nickname)).sort();
    const patterns = makePatterns({ exclusion: { count: names.length, sha256: 'x', names } });
    const bots = generateRoster({ seed: 111, count: 1000, patterns });
    expect(bots.length).toBe(1000);
    const excl = new Set(names);
    for (const b of bots) expect(excl.has(normalizeForExclusion(b.nickname))).toBe(false);
  });
});

describe('roster generator — distribution tolerances vs patterns', () => {
  const patterns = makePatterns();
  const bots = generateRoster({ seed: 2026, count: 2000, patterns });
  const N = bots.length;

  it('skill bands follow the 20/30/30/15/5 split within tolerance', () => {
    const counts = [0, 0, 0, 0, 0];
    for (const b of bots) counts[b.skillBand]!++;
    const target = [0.2, 0.3, 0.3, 0.15, 0.05];
    for (let i = 0; i < 5; i++) {
      expect(Math.abs(counts[i]! / N - target[i]!)).toBeLessThan(0.04);
    }
  });

  it('country distribution is GE-dominant per the override', () => {
    const ge = bots.filter((b) => b.country === 'GE').length / N;
    expect(ge).toBeGreaterThan(0.78);
    expect(ge).toBeLessThan(0.92);
  });

  it('two-word rate is within tolerance of the measured rate', () => {
    const twoWord = bots.filter((b) => b.nickname.trim().split(/\s+/).length === 2).length / N;
    expect(Math.abs(twoWord - patterns.name.twoWordRate)).toBeLessThan(0.1);
  });

  it('favorite_club stays sparse (near the measured null-rate)', () => {
    const withClub = bots.filter((b) => b.favoriteClub).length / N;
    expect(withClub).toBeLessThan(0.05);
  });

  it('rename flags near the target lifetime rate', () => {
    const willRename = bots.filter((b) => b.willRename).length / N;
    expect(Math.abs(willRename - patterns.rename.lifetimeRate)).toBeLessThan(0.05);
  });
});

describe('roster generator — field validity', () => {
  const bots = generateRoster({ seed: 8, count: 500, patterns: makePatterns() });

  it('personality_seed is a JS-safe integer (< 2^53)', () => {
    for (const b of bots) {
      expect(b.personalitySeed).toBeGreaterThanOrEqual(0n);
      expect(b.personalitySeed).toBeLessThan(2n ** 53n);
    }
  });

  it('daily cap comes from the empirical quantile set', () => {
    const allowed = new Set([2, 3, 8, 14, 20]);
    for (const b of bots) expect(allowed.has(b.dailyCap)).toBe(true);
  });

  it('category affinities: 2-4 strengths + 2-4 weaknesses, bounded', () => {
    for (const b of bots) {
      const vals = Object.values(b.categoryAffinities);
      const strengths = vals.filter((v) => v > 0).length;
      const weaknesses = vals.filter((v) => v < 0).length;
      expect(strengths).toBeGreaterThanOrEqual(2);
      expect(strengths).toBeLessThanOrEqual(4);
      expect(weaknesses).toBeGreaterThanOrEqual(2);
      expect(weaknesses).toBeLessThanOrEqual(4);
      for (const v of vals) expect(Math.abs(v)).toBeLessThanOrEqual(0.2);
    }
  });

  it('home city/coords consistent with country (GE cities only for GE)', () => {
    const geCities = new Set(['Tbilisi', 'Batumi', 'Kutaisi', 'Rustavi', 'Zugdidi', 'Gori', 'Poti', 'Telavi', 'Ozurgeti', 'Akhaltsikhe']);
    for (const b of bots) {
      if (b.country === 'GE' && b.homeCity) expect(geCities.has(b.homeCity)).toBe(true);
      if (b.homeCity) {
        expect(b.homeLat).not.toBeNull();
        expect(b.homeLng).not.toBeNull();
      }
    }
  });

  it('base_skill lies within its band range', () => {
    const ranges = makePatterns().skill.bandRanges;
    for (const b of bots) {
      const [lo, hi] = ranges[b.skillBand]!;
      expect(b.baseSkill).toBeGreaterThanOrEqual(lo);
      expect(b.baseSkill).toBeLessThanOrEqual(hi);
    }
  });
});

describe('prng primitives', () => {
  it('mulberry32 is deterministic and in [0,1)', () => {
    const r1 = mulberry32(123);
    const r2 = mulberry32(123);
    for (let i = 0; i < 100; i++) {
      const v = r1();
      expect(v).toBe(r2());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('adjacent field keys yield uncorrelated first draws', () => {
    // A weak PRNG seeded with seed+i correlates; xmur3 mixing must decorrelate.
    const firsts: number[] = [];
    for (let i = 0; i < 200; i++) firsts.push(fieldRng(1000, i, 'name')());
    const mean = firsts.reduce((a, b) => a + b, 0) / firsts.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.06);
    // No two adjacent draws should be suspiciously identical.
    let adjClose = 0;
    for (let i = 1; i < firsts.length; i++) if (Math.abs(firsts[i]! - firsts[i - 1]!) < 0.001) adjClose++;
    expect(adjClose).toBeLessThan(5);
  });

  it('personalitySeed is stable per (seed,index)', () => {
    expect(personalitySeed(5, 10)).toBe(personalitySeed(5, 10));
    expect(personalitySeed(5, 10)).not.toBe(personalitySeed(5, 11));
  });

  it('weightedPick respects weights over many draws', () => {
    const rng = mulberry32(7);
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 10000; i++) counts[weightedPick(rng, ['a', 'b'] as const, [9, 1])]++;
    expect(counts.a / (counts.a + counts.b)).toBeGreaterThan(0.85);
  });

  it('quantileSample honors the empirical quantiles', () => {
    const rng = mulberry32(3);
    const q: [number, number][] = [[0.5, 2], [0.9, 8], [1.0, 20]];
    const counts = new Map<number, number>();
    for (let i = 0; i < 10000; i++) {
      const v = quantileSample(rng, q);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    expect((counts.get(2) ?? 0) / 10000).toBeGreaterThan(0.4);
    expect((counts.get(20) ?? 0) / 10000).toBeLessThan(0.2);
  });
});

describe('safe-integer seeds', () => {
  it('accepts a max-safe-integer seed and stays deterministic', () => {
    const patterns = makePatterns();
    const seed = Number.MAX_SAFE_INTEGER;
    const a = generateRoster({ seed, count: 50, patterns });
    const b = generateRoster({ seed, count: 50, patterns });
    expect(a.map((x) => x.nickname)).toEqual(b.map((x) => x.nickname));
  });
});

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}
function normalize(b: unknown): unknown {
  return JSON.parse(JSON.stringify(b, bigintReplacer));
}
