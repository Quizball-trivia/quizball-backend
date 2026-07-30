import { deriveSeed } from './rng.js';

export type SkillBand = 0 | 1 | 2 | 3 | 4;

export interface S2TierBand {
  name: string;
  lo: number;
  hi: number;
  n: number;
}

export const S2_TIER_TABLE: readonly S2TierBand[] = [
  { name: 'Academy', lo: 100, hi: 300, n: 111 },
  { name: 'Youth Prospect', lo: 300, hi: 600, n: 80 },
  { name: 'Reserve', lo: 600, hi: 1000, n: 37 },
  { name: 'Bench', lo: 1000, hi: 1500, n: 35 },
  { name: 'Rotation', lo: 1500, hi: 2200, n: 42 },
  { name: 'Starting11', lo: 2200, hi: 2415, n: 20 },
];

export const S2_TIERS = S2_TIER_TABLE;

export const BAND_PERCENTILE_TABLE: Readonly<Record<SkillBand, readonly [number, number]>> = {
  0: [0, 20],
  1: [20, 50],
  2: [50, 80],
  3: [80, 95],
  4: [95, 100],
};

export const BAND_PERCENTILES = BAND_PERCENTILE_TABLE;

const S2_POPULATION = S2_TIER_TABLE.reduce((sum, tier) => sum + tier.n, 0);
const SKILL_BAND_UPPER_BOUNDS = [0.25, 0.45, 0.6, 0.75] as const;

export function s2RpAtPercentile(percentile: number): number {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
    throw new RangeError(`percentile must be in [0,100], got ${percentile}`);
  }
  if (percentile === 100) return S2_TIER_TABLE[S2_TIER_TABLE.length - 1].hi;

  const populationPosition = (percentile / 100) * S2_POPULATION;
  let cumulative = 0;
  for (const tier of S2_TIER_TABLE) {
    const next = cumulative + tier.n;
    if (populationPosition < next) {
      const withinTier = (populationPosition - cumulative) / tier.n;
      return tier.lo + withinTier * (tier.hi - tier.lo);
    }
    cumulative = next;
  }
  return S2_TIER_TABLE[S2_TIER_TABLE.length - 1].hi;
}

export function seededRpForBot(input: {
  userId: string;
  band: SkillBand;
  skillRankInBand: number;
  bandSize: number;
  ceilingRp: number;
}): number {
  const { band, skillRankInBand, bandSize, ceilingRp } = input;
  if (!Number.isInteger(skillRankInBand) || bandSize <= 0 || skillRankInBand < 0 || skillRankInBand >= bandSize) {
    throw new RangeError(`invalid rank ${skillRankInBand} for band size ${bandSize}`);
  }
  const [lo, hi] = BAND_PERCENTILE_TABLE[band];
  const position = (skillRankInBand + 0.5) / bandSize;
  const rawRp = s2RpAtPercentile(lo + position * (hi - lo));
  return Math.min(Math.round(rawRp), Math.floor(ceilingRp));
}

export interface SeedableBot {
  userId: string;
  baseSkill: number;
  skillBand?: SkillBand;
}

export interface SeededBot {
  userId: string;
  band: SkillBand;
  skillRankInBand: number;
  bandSize: number;
  seededRp: number;
}

export function placementWinsForBand(band: SkillBand): number {
  return Math.floor(((band + 1) * 3) / 5);
}

export function skillBandFromBaseSkill(baseSkill: number): SkillBand {
  for (let band = 0; band < SKILL_BAND_UPPER_BOUNDS.length; band++) {
    if (baseSkill < SKILL_BAND_UPPER_BOUNDS[band]) return band as SkillBand;
  }
  return 4;
}

export function seedRosterBots(
  bots: readonly SeedableBot[],
  seed: number,
  ceilingRp: number,
): SeededBot[] {
  const byBand = new Map<SkillBand, SeedableBot[]>();
  for (const bot of bots) {
    const band = bot.skillBand ?? skillBandFromBaseSkill(bot.baseSkill);
    const group = byBand.get(band) ?? [];
    group.push(bot);
    byBand.set(band, group);
  }

  const seeded: SeededBot[] = [];
  for (let band = 0; band <= 4; band++) {
    const skillBand = band as SkillBand;
    const group = byBand.get(skillBand) ?? [];
    group.sort((a, b) => {
      if (a.baseSkill !== b.baseSkill) return a.baseSkill - b.baseSkill;
      const jitterA = deriveSeed(seed, a.userId);
      const jitterB = deriveSeed(seed, b.userId);
      if (jitterA !== jitterB) return jitterA - jitterB;
      return a.userId.localeCompare(b.userId);
    });
    group.forEach((bot, skillRankInBand) => {
      seeded.push({
        userId: bot.userId,
        band: skillBand,
        skillRankInBand,
        bandSize: group.length,
        seededRp: seededRpForBot({
          userId: bot.userId,
          band: skillBand,
          skillRankInBand,
          bandSize: group.length,
          ceilingRp,
        }),
      });
    });
  }
  return seeded;
}
