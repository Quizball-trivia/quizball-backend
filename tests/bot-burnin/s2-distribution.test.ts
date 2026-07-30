import { describe, expect, it } from 'vitest';
import { tierFromRp } from '../../src/modules/ranked/season-rp-formula.js';
import { MAX_WIN_DELTA } from '../../scripts/bot-burnin/scheduler.js';
import {
  BAND_PERCENTILE_TABLE,
  S2_TIER_TABLE,
  s2RpAtPercentile,
  seedRosterBots,
  seededRpForBot,
  type SeedableBot,
  type SkillBand,
} from '../../scripts/bot-burnin/s2-distribution.js';

const BAND_COUNTS = [200, 300, 300, 150, 50] as const;
const SKILL_RANGES = [[0.05, 0.25], [0.25, 0.45], [0.45, 0.6], [0.6, 0.75], [0.75, 0.9]] as const;

function syntheticRoster(): SeedableBot[] {
  const bots: SeedableBot[] = [];
  let ordinal = 0;
  BAND_COUNTS.forEach((count, bandIndex) => {
    const band = bandIndex as SkillBand;
    const [lo, hi] = SKILL_RANGES[band];
    for (let rank = 0; rank < count; rank++) {
      bots.push({
        userId: `00000000-0000-4000-8000-${String(ordinal++).padStart(12, '0')}`,
        baseSkill: lo + ((rank + 0.5) / count) * (hi - lo),
        skillBand: band,
      });
    }
  });
  return bots;
}

describe('S2 human target quantile', () => {
  it('is monotone and reproduces tier cumulative population shares', () => {
    let previous = s2RpAtPercentile(0);
    for (let percentile = 0.1; percentile <= 100; percentile += 0.1) {
      const current = s2RpAtPercentile(Math.min(100, percentile));
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }

    const total = S2_TIER_TABLE.reduce((sum, tier) => sum + tier.n, 0);
    let cumulative = 0;
    for (const tier of S2_TIER_TABLE.slice(0, -1)) {
      cumulative += tier.n;
      expect(s2RpAtPercentile((cumulative / total) * 100)).toBeCloseTo(tier.hi, 8);
    }
    expect(S2_TIER_TABLE[0].n / total).toBeCloseTo(0.3415, 3);
  });

  it('maps every hidden band to its specified percentile interval', () => {
    expect(BAND_PERCENTILE_TABLE).toEqual({
      0: [0, 20],
      1: [20, 50],
      2: [50, 80],
      3: [80, 95],
      4: [95, 100],
    });
  });
});

describe('S2 seeded roster', () => {
  it('mirrors the S2 tier shape without band inversion', () => {
    const seeded = seedRosterBots(syntheticRoster(), 20260721, 2565);
    const actual = new Map<string, number>();
    for (const bot of seeded) {
      const tier = tierFromRp(bot.seededRp);
      actual.set(tier, (actual.get(tier) ?? 0) + 1);
    }
    const totalHumans = S2_TIER_TABLE.reduce((sum, tier) => sum + tier.n, 0);
    for (const tier of S2_TIER_TABLE) {
      const botShare = (actual.get(tier.name) ?? 0) / seeded.length;
      expect(Math.abs(botShare - tier.n / totalHumans)).toBeLessThan(0.01);
    }

    const ranges = BAND_COUNTS.map((_, bandIndex) => {
      const values = seeded
        .filter((bot) => bot.band === bandIndex)
        .map((bot) => bot.seededRp)
        .sort((a, b) => a - b);
      return {
        min: values[0],
        median: values[Math.floor(values.length / 2)],
        max: values[values.length - 1],
      };
    });
    for (let band = 1; band < ranges.length; band++) {
      expect(ranges[band].median).toBeGreaterThan(ranges[band - 1].median);
      expect(ranges[band].min).toBeGreaterThanOrEqual(ranges[band - 1].max);
    }
  });

  it('is deterministic and obeys the default ceiling headroom', () => {
    const roster = syntheticRoster();
    const first = seedRosterBots(roster, 20260721, 2565);
    const second = seedRosterBots([...roster].reverse(), 20260721, 2565);
    const normalized = (bots: typeof first) => [...bots]
      .sort((a, b) => a.userId.localeCompare(b.userId))
      .map(({ userId, seededRp }) => ({ userId, seededRp }));
    expect(normalized(first)).toEqual(normalized(second));
    for (const bot of first) {
      expect(bot.seededRp).toBeLessThanOrEqual(2565);
      expect(bot.seededRp + MAX_WIN_DELTA).toBeLessThanOrEqual(2565);
    }
  });

  it('caps an individual seed at ceilingRp', () => {
    expect(seededRpForBot({
      userId: 'bot',
      band: 4,
      skillRankInBand: 9,
      bandSize: 10,
      ceilingRp: 2300,
    })).toBe(2300);
  });
});
