/**
 * Dry-run distribution report. Consumes the simulated final bot states + the
 * fixture plan and produces the convergence figures the operator reviews BEFORE
 * any write: per-band final distribution, matches/bot histogram, ceiling
 * respect, and sample bot timelines.
 */
import { tierFromRp } from '../../src/modules/ranked/ranked.service.js';
import { BAND_TARGETS, type BurnInBot, type PlannedFixture, type DistributionReport } from './types.js';

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function bandOf(rp: number): string {
  for (const b of BAND_TARGETS) if (rp >= b.minRp) return b.name;
  return BAND_TARGETS[BAND_TARGETS.length - 1].name;
}

export function buildReport(opts: {
  finalBots: BurnInBot[];
  fixtures: PlannedFixture[];
  ceilingRp: number;
  humanTop10Rp: number | null;
}): DistributionReport {
  const { finalBots, fixtures, ceilingRp, humanTop10Rp } = opts;

  const fixtureCountByBot = new Map<string, number>();
  const winsByBot = new Map<string, number>();
  for (const f of fixtures) {
    fixtureCountByBot.set(f.botAUserId, (fixtureCountByBot.get(f.botAUserId) ?? 0) + 1);
    fixtureCountByBot.set(f.botBUserId, (fixtureCountByBot.get(f.botBUserId) ?? 0) + 1);
    winsByBot.set(f.winnerUserId, (winsByBot.get(f.winnerUserId) ?? 0) + 1);
  }

  const counts = finalBots.map((b) => fixtureCountByBot.get(b.userId) ?? 0).sort((a, b) => a - b);
  const matchesPerBot = {
    min: counts[0] ?? 0,
    max: counts[counts.length - 1] ?? 0,
    median: median(counts),
    mean: counts.length ? counts.reduce((s, c) => s + c, 0) / counts.length : 0,
  };

  const bandActual: Record<string, number> = {};
  const bandTargets: Record<string, number> = {};
  for (const b of BAND_TARGETS) {
    bandActual[b.name] = 0;
    bandTargets[b.name] = Math.round(b.share * finalBots.length);
  }
  let maxBotRp = 0;
  for (const bot of finalBots) {
    bandActual[bandOf(bot.rp)] += 1;
    if (bot.rp > maxBotRp) maxBotRp = bot.rp;
  }

  // Sample timelines: the 3 strongest + 3 weakest + 2 median bots.
  const byRp = [...finalBots].sort((a, b) => b.rp - a.rp);
  const picks = [
    ...byRp.slice(0, 3),
    byRp[Math.floor(byRp.length / 2)],
    byRp[Math.floor(byRp.length / 2) + 1],
    ...byRp.slice(-3),
  ].filter((b, i, arr) => b && arr.indexOf(b) === i);

  const sampleTimelines = picks.map((bot) => {
    const fixtures_ = fixtureCountByBot.get(bot.userId) ?? 0;
    const wins = winsByBot.get(bot.userId) ?? 0;
    return {
      nickname: bot.nickname,
      baseSkill: Number(bot.baseSkill.toFixed(3)),
      finalRp: bot.rp,
      tier: tierFromRp(bot.rp),
      fixtures: fixtures_,
      wins,
      losses: fixtures_ - wins,
    };
  });

  return {
    botCount: finalBots.length,
    fixtureCount: fixtures.length,
    matchesPerBot,
    bandTargets,
    bandActual,
    ceilingRp,
    humanTop10Rp,
    maxBotRp,
    ceilingRespected: maxBotRp <= ceilingRp,
    sampleTimelines,
  };
}

export function formatReport(r: DistributionReport): string {
  const lines: string[] = [];
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('  PERSISTENT-BOT BURN-IN — DRY-RUN DISTRIBUTION REPORT');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`Roster bots:        ${r.botCount}`);
  lines.push(`Planned fixtures:   ${r.fixtureCount}`);
  lines.push(
    `Matches / bot:      min ${r.matchesPerBot.min}  median ${r.matchesPerBot.median}  ` +
      `mean ${r.matchesPerBot.mean.toFixed(1)}  max ${r.matchesPerBot.max}`,
  );
  lines.push('');
  lines.push('Hard ceiling');
  lines.push('────────────');
  lines.push(`  human #10 RP:     ${r.humanTop10Rp ?? '(fewer than 10 placed humans)'}`);
  lines.push(`  ceiling RP:       ${r.ceilingRp}`);
  lines.push(`  max bot RP:       ${r.maxBotRp}`);
  lines.push(`  respected:        ${r.ceilingRespected ? 'YES ✓' : 'NO ✗ — ABORT'}`);
  lines.push('');
  lines.push('Ladder bands (final RP)          target   actual');
  lines.push('─────────────────────────────────────────────────');
  for (const name of Object.keys(r.bandTargets)) {
    const t = String(r.bandTargets[name]).padStart(6);
    const a = String(r.bandActual[name]).padStart(6);
    lines.push(`  ${name.padEnd(28)} ${t}   ${a}`);
  }
  lines.push('');
  lines.push('Sample bot timelines');
  lines.push('────────────────────');
  lines.push('  nickname                skill    RP     tier            W-L (n)');
  for (const t of r.sampleTimelines) {
    lines.push(
      `  ${t.nickname.padEnd(22).slice(0, 22)} ${String(t.baseSkill).padStart(6)}  ` +
        `${String(t.finalRp).padStart(5)}  ${t.tier.padEnd(14)}  ${t.wins}-${t.losses} (${t.fixtures})`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
