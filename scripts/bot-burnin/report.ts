import { tierFromRp } from '../../src/modules/ranked/season-rp-formula.js';
import {
  S2_TIER_TABLE,
  seedRosterBots,
  type SeededBot,
  type SkillBand,
} from './s2-distribution.js';
import type { BurnInBot, PlannedFixture, DistributionReport } from './types.js';

const TIER_ORDER = [
  'GOAT',
  'Legend',
  'World-Class',
  'Captain',
  'Key Player',
  'Starting11',
  'Rotation',
  'Bench',
  'Reserve',
  'Youth Prospect',
  'Academy',
] as const;

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function quantile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index];
}

function buildLadder(
  name: 'UNCAPPED' | 'CAPPED',
  seededBots: SeededBot[],
  ceilingRp: number,
): DistributionReport['ladders'][number] {
  const rps = seededBots.map((bot) => bot.seededRp).sort((a, b) => a - b);
  const humanCounts = new Map(S2_TIER_TABLE.map((tier) => [tier.name, tier.n]));
  const botCounts = new Map<string, number>();
  for (const bot of seededBots) {
    const tier = tierFromRp(bot.seededRp);
    botCounts.set(tier, (botCounts.get(tier) ?? 0) + 1);
  }

  const bands = Array.from({ length: 5 }, (_, index) => index as SkillBand).map((band) => {
    const values = seededBots
      .filter((bot) => bot.band === band)
      .map((bot) => bot.seededRp)
      .sort((a, b) => a - b);
    return {
      band,
      min: values[0] ?? 0,
      median: median(values),
      max: values[values.length - 1] ?? 0,
    };
  });

  return {
    name,
    ceilingRp,
    tierHistogram: TIER_ORDER.map((tier) => ({
      tier,
      bots: botCounts.get(tier) ?? 0,
      s2Humans: humanCounts.get(tier) ?? 0,
    })),
    quantiles: {
      p5: quantile(rps, 5),
      p20: quantile(rps, 20),
      p50: quantile(rps, 50),
      p80: quantile(rps, 80),
      p95: quantile(rps, 95),
      p99: quantile(rps, 99),
      max: rps[rps.length - 1] ?? 0,
    },
    bands,
  };
}

export function buildReport(opts: {
  bots: BurnInBot[];
  seed: number;
  finalBots: BurnInBot[];
  fixtures: PlannedFixture[];
  ceilingRp: number;
  humanTop10Rp: number | null;
}): DistributionReport {
  const { bots, seed, finalBots, fixtures, ceilingRp, humanTop10Rp } = opts;

  const fixtureCountByBot = new Map<string, number>();
  const winsByBot = new Map<string, number>();
  for (const fixture of fixtures) {
    fixtureCountByBot.set(fixture.botAUserId, (fixtureCountByBot.get(fixture.botAUserId) ?? 0) + 1);
    fixtureCountByBot.set(fixture.botBUserId, (fixtureCountByBot.get(fixture.botBUserId) ?? 0) + 1);
    winsByBot.set(fixture.winnerUserId, (winsByBot.get(fixture.winnerUserId) ?? 0) + 1);
  }

  const counts = finalBots.map((bot) => fixtureCountByBot.get(bot.userId) ?? 0).sort((a, b) => a - b);
  const matchesPerBot = {
    min: counts[0] ?? 0,
    max: counts[counts.length - 1] ?? 0,
    median: median(counts),
    mean: counts.length ? counts.reduce((sum, count) => sum + count, 0) / counts.length : 0,
  };

  const cappedSeeds = seedRosterBots(bots, seed, ceilingRp);
  const uncappedSeeds = seedRosterBots(bots, seed, Number.POSITIVE_INFINITY);
  const cappedById = new Map(cappedSeeds.map((bot) => [bot.userId, bot.seededRp]));
  const maxBotRp = finalBots.reduce((max, bot) => Math.max(max, bot.rp), 0);

  const byRp = [...finalBots].sort((a, b) => b.rp - a.rp);
  const picks = [
    ...byRp.slice(0, 3),
    byRp[Math.floor(byRp.length / 2)],
    byRp[Math.floor(byRp.length / 2) + 1],
    ...byRp.slice(-3),
  ].filter((bot, index, all) => bot && all.indexOf(bot) === index);

  const sampleTimelines = picks.map((bot) => {
    const botFixtures = fixtureCountByBot.get(bot.userId) ?? 0;
    const wins = winsByBot.get(bot.userId) ?? 0;
    return {
      nickname: bot.nickname,
      baseSkill: Number(bot.baseSkill.toFixed(3)),
      seedRp: cappedById.get(bot.userId) ?? 0,
      finalRp: bot.rp,
      tier: tierFromRp(bot.rp),
      fixtures: botFixtures,
      wins,
      losses: botFixtures - wins,
    };
  });

  return {
    botCount: finalBots.length,
    fixtureCount: fixtures.length,
    matchesPerBot,
    ladders: [
      buildLadder('UNCAPPED', uncappedSeeds, Number.POSITIVE_INFINITY),
      buildLadder('CAPPED', cappedSeeds, ceilingRp),
    ],
    ceilingRp,
    humanTop10Rp,
    maxBotRp,
    ceilingRespected: maxBotRp <= ceilingRp,
    sampleTimelines,
  };
}

export function formatReport(report: DistributionReport): string {
  const lines: string[] = [];
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('  PERSISTENT-BOT BURN-IN — DRY-RUN DISTRIBUTION REPORT');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`Roster bots:        ${report.botCount}`);
  lines.push(`Planned fixtures:   ${report.fixtureCount}`);
  lines.push(
    `Matches / bot:      min ${report.matchesPerBot.min}  median ${report.matchesPerBot.median}  ` +
      `mean ${report.matchesPerBot.mean.toFixed(1)}  max ${report.matchesPerBot.max}`,
  );
  lines.push('');
  lines.push('Hard ceiling');
  lines.push('────────────');
  lines.push(`  human #10 RP:     ${report.humanTop10Rp ?? '(fewer than 10 placed humans)'}`);
  lines.push(`  ceiling RP:       ${report.ceilingRp}`);
  lines.push(`  max final bot RP: ${report.maxBotRp}`);
  lines.push(`  respected:        ${report.ceilingRespected ? 'YES ✓' : 'NO ✗ — ABORT'}`);

  for (const ladder of report.ladders) {
    lines.push('');
    lines.push(`${ladder.name} SEEDED LADDER${ladder.name === 'UNCAPPED' ? ' — nearly identical because the S2 target barely exceeds the cap' : ''}`);
    lines.push('──────────────────────────────────────────────────────────────');
    lines.push(`  ceiling: ${Number.isFinite(ladder.ceilingRp) ? ladder.ceilingRp : 'Infinity'}`);
    lines.push(
      `  RP quantiles: p5=${ladder.quantiles.p5} p20=${ladder.quantiles.p20} ` +
        `p50=${ladder.quantiles.p50} p80=${ladder.quantiles.p80} p95=${ladder.quantiles.p95} ` +
        `p99=${ladder.quantiles.p99} max=${ladder.quantiles.max}`,
    );
    lines.push('');
    lines.push('  Tier                 bots   S2 humans');
    for (const row of ladder.tierHistogram) {
      lines.push(`  ${row.tier.padEnd(20)} ${String(row.bots).padStart(5)}   ${String(row.s2Humans).padStart(9)}`);
    }
    lines.push('');
    lines.push('  Hidden band        min   median   max');
    for (const band of ladder.bands) {
      lines.push(
        `  band${band.band}${' '.repeat(13)}${String(band.min).padStart(4)}   ` +
          `${String(band.median).padStart(6)}   ${String(band.max).padStart(4)}`,
      );
    }
  }

  lines.push('');
  lines.push('Stage B sample timelines');
  lines.push('────────────────────────');
  lines.push('  nickname                skill   seed→final   tier            W-L (n)');
  for (const timeline of report.sampleTimelines) {
    lines.push(
      `  ${timeline.nickname.padEnd(22).slice(0, 22)} ${String(timeline.baseSkill).padStart(6)}  ` +
        `${`${timeline.seedRp}→${timeline.finalRp}`.padStart(10)}  ${timeline.tier.padEnd(14)}  ` +
        `${timeline.wins}-${timeline.losses} (${timeline.fixtures})`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
