/**
 * Dry-run report renderer: markdown (human review + approval gate) + CSV (full
 * 1,000-row table). The markdown carries an APPROVAL REQUIRED header with the
 * seed and instructions; its sha256 is what the creation script demands.
 */

import type { RosterPatterns, WeightedString } from './patterns.js';
import { DAILY_CAP_CEILING, type GeneratedBot } from './roster.js';

const BAND_LABELS = ['B1 (bottom)', 'B2', 'B3', 'B4', 'B5 (top)'];

function pct(n: number, d: number): string {
  return d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(1)}%`;
}

function tally<T>(items: T[], keyOf: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = keyOf(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(bots: GeneratedBot[]): string {
  const header = [
    'index', 'nickname', 'country', 'city', 'club', 'band', 'daily_cap',
    'schedule', 'rename_flag', 'base_skill', 'consistency', 'speed_offset',
    'affinities', 'has_avatar', 'personality_seed',
  ];
  const lines = [header.join(',')];
  for (const b of bots) {
    lines.push([
      b.index,
      b.nickname,
      b.country,
      b.homeCity ?? '',
      b.favoriteClub ?? '',
      BAND_LABELS[b.skillBand],
      b.dailyCap,
      b.schedule.archetype,
      b.willRename ? 'yes' : 'no',
      b.baseSkill,
      b.consistency,
      b.speedOffset,
      Object.entries(b.categoryAffinities).map(([k, v]) => `${k}:${v}`).join(' '),
      b.avatarCustomization ? 'yes' : 'no',
      b.personalitySeed.toString(),
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

function distTable(measured: WeightedString[], gen: Map<string, number>, total: number): string {
  const mTotal = measured.reduce((a, b) => a + b.weight, 0) || 1;
  const rows = ['| value | measured share | generated share |', '|---|---|---|'];
  const seen = new Set<string>();
  for (const m of measured.slice(0, 12)) {
    seen.add(m.value);
    rows.push(`| ${m.value} | ${((m.weight / mTotal) * 100).toFixed(1)}% | ${pct(gen.get(m.value) ?? 0, total)} |`);
  }
  for (const [k, v] of gen) {
    if (!seen.has(k)) rows.push(`| ${k} | — | ${pct(v, total)} |`);
  }
  return rows.join('\n');
}

export interface ReportInputs {
  seed: number;
  count: number;
  patterns: RosterPatterns;
  bots: GeneratedBot[];
  effectiveSpaceProbe?: { distinctSampled: number; sampleSize: number };
  /** Digest of the full canonicalized roster, bound in the manifest. */
  rosterSha?: string;
}

export function renderReport(input: ReportInputs): string {
  const { seed, count, patterns, bots } = input;
  const out: string[] = [];

  out.push('# Persistent Bot Roster — DRY-RUN REPORT');
  out.push('');
  out.push('> **APPROVAL REQUIRED.** Nothing has been written to any database. Review this');
  out.push('> report in full. To create this exact roster, approve it by passing this file\'s');
  out.push('> sha256 to the creation script, which consumes the accompanying manifest as its');
  out.push('> single source of truth:');
  out.push('>');
  out.push('> ```');
  out.push('> tsx scripts/persistent-bot-roster/create.ts \\');
  out.push('>   --manifest scripts/persistent-bot-roster/out/roster.manifest.json \\');
  out.push('>   --report  scripts/persistent-bot-roster/out/REPORT.md \\');
  out.push('>   --patterns scripts/persistent-bot-roster/patterns.json \\');
  out.push('>   --approved-report <sha256-of-THIS-file> \\');
  out.push('>   --batch <unique-batch-id>');
  out.push('> ```');
  out.push('>');
  out.push('> The manifest binds the report hash, patterns hash, seed, count, exclusion');
  out.push('> snapshot, and a digest of ALL rows. Creation refuses to run unless (a) the report');
  out.push('> bytes hash to `--approved-report` AND to `manifest.reportSha256`, (b) the supplied');
  out.push('> patterns.json hashes to `manifest.patternsSha256`, and (c) regenerating from the');
  out.push('> manifest seed/count reproduces `manifest.rosterSha256`. There are no independent');
  out.push('> patterns/count inputs that could pair an approved report with a different roster.');
  out.push('');
  if (input.rosterSha) {
    out.push(`- **Roster digest (manifest.rosterSha256):** \`${input.rosterSha}\``);
  }
  out.push(`- **Seed:** \`${seed}\``);
  out.push(`- **Roster size:** ${count}`);
  out.push(`- **patterns.json measured against:** ${patterns.measuredAgainst}`);
  out.push(`- **patterns.json generated at:** ${patterns.generatedAt}`);
  out.push(`- **Frozen exclusion set:** ${patterns.exclusion.count} names, sha256 \`${patterns.exclusion.sha256}\``);
  out.push('');

  // Cohort + methodology
  out.push('## Cohort & methodology');
  out.push('');
  out.push(`- Real users with an identity: **${patterns.cohort.realWithIdentity}**`);
  out.push(`- ...with a chosen (non-null) nickname: **${patterns.cohort.namedUsers}**`);
  out.push(`- ...named AND ever played a match (name-pattern cohort): **${patterns.cohort.namedAndPlayed}**`);
  out.push(`- Distinct real users who ever played a match: **${patterns.cohort.everPlayed}**`);
  out.push('');
  out.push(`Name STRUCTURE (word count, casing, digit/separator rates, trailing-digit tokens) is`);
  out.push(`measured over the **named-and-played** cohort (n=${patterns.name.cohortSize}) — the population the`);
  out.push('bots impersonate. The ~11k never-named signups carry no name signal and are excluded.');
  out.push(`Small-n caveat: at this sample size, rates under ~3% (e.g. Georgian-script, underscore)`);
  out.push('are 1–2 people and are treated as rare/presence-only, deliberately not reproduced at their');
  out.push('exact single-user frequency.');
  out.push('');
  if (input.effectiveSpaceProbe) {
    const p = input.effectiveSpaceProbe;
    out.push(`Effective name space probe: ${p.distinctSampled} distinct names in ${p.sampleSize} independent`);
    out.push(`draws (${pct(p.distinctSampled, p.sampleSize)} unique) — the reachable space comfortably exceeds`);
    out.push(`roster size + exclusion set, so rejection sampling rarely re-draws.`);
    out.push('');
  }

  // OVERRIDDEN disclosures
  out.push('## OVERRIDDEN distributions (deliberate divergence from measured data)');
  out.push('');
  out.push('These fields do NOT mimic the raw measurement because the raw signal is a');
  out.push('contaminated artifact. Approving this report attests to these decisions.');
  out.push('');
  out.push('### Country — OVERRIDDEN');
  out.push('');
  out.push(patterns.country.rationale ?? '');
  out.push('');
  out.push('Raw measured (top): ' + patterns.country.rawMeasured.slice(0, 8).map((c) => `${c.value} ${c.weight}`).join(', '));
  out.push('');
  out.push('Imposed target: ' + patterns.country.distribution.map((c) => `${c.value} ${c.weight}`).join(', '));
  out.push('');
  out.push('### Avatar hair — OVERRIDDEN');
  out.push('');
  const rawHair = patterns.avatar.rawHairMeasured ?? [];
  const rawHairTotal = rawHair.reduce((a, b) => a + b.weight, 0) || 1;
  out.push(`Raw hair is ~${((rawHair[0]?.weight ?? 0) / rawHairTotal * 100).toFixed(0)}% the app-default \`hair_boy_basic\` — an artifact of`);
  out.push('most users never customizing. Reproducing it would make 1,000 bots look copy-pasted, so');
  out.push('the default is flattened to a plurality and other hairstyles are lifted to a visible floor.');
  out.push('');
  out.push('### Rename propensity — OVERRIDDEN');
  out.push('');
  out.push(`Staging under-samples renames (measured ${(patterns.rename.rawMeasuredRate * 100).toFixed(2)}% — very young data). The`);
  out.push(`generator uses the plan target lifetime rename rate of ${(patterns.rename.lifetimeRate * 100).toFixed(0)}%.`);
  out.push('');
  if (patterns.activity.source === 'overridden') {
    out.push('### Activity archetype MIX — OVERRIDDEN (session/cap distributions MEASURED)');
    out.push('');
    out.push(`Per-user sessionization runs over ${patterns.activity.usersClustered} players, and each archetype's`);
    out.push('session-length and daily-cap distributions are MEASURED from its members. The archetype');
    out.push('MIX WEIGHTS, however, are imposed to the plan design (evening-dominant, night-owl a');
    out.push('~3% minority): the per-user modal-hour signal is contaminated — a timestamp artifact');
    out.push('parks ~46% of users at exactly 00:00 Tbilisi — so weighting the mix by measured modal');
    out.push('hours would be meaningless. Night-owl caps are additionally clamped below the plan\'s');
    out.push('15-match ceiling.');
    out.push('');
  }

  // Distribution summaries side-by-side
  out.push('## Distribution summaries (generated vs measured)');
  out.push('');

  // Name structure
  const digitCount = bots.filter((b) => /[0-9]/.test(b.nickname)).length;
  const spaceCount = bots.filter((b) => / /.test(b.nickname)).length;
  const lowerCount = bots.filter((b) => b.nickname === b.nickname.toLowerCase() && /[a-z]/.test(b.nickname)).length;
  const twoWordCount = bots.filter((b) => b.nickname.trim().split(/\s+/).length === 2).length;
  const geoCount = bots.filter((b) => /[Ⴀ-ჿ]/.test(b.nickname)).length;
  out.push('### Name structure');
  out.push('');
  out.push('| feature | measured | generated |');
  out.push('|---|---|---|');
  out.push(`| single-word | ${(patterns.name.singleWordRate * 100).toFixed(1)}% | ${pct(count - twoWordCount, count)} |`);
  out.push(`| two-word (first+last) | ${(patterns.name.twoWordRate * 100).toFixed(1)}% | ${pct(twoWordCount, count)} |`);
  out.push(`| has digit | ${(patterns.name.digitRate * 100).toFixed(1)}% | ${pct(digitCount, count)} |`);
  out.push(`| has space | ${(patterns.name.separators.space * 100).toFixed(1)}% | ${pct(spaceCount, count)} |`);
  out.push(`| all-lowercase | ${(patterns.name.casing.allLower * 100).toFixed(1)}% | ${pct(lowerCount, count)} |`);
  out.push(`| Georgian-script | ${(patterns.name.georgianScriptRate * 100).toFixed(1)}% | ${pct(geoCount, count)} |`);
  out.push('');

  // Countries
  out.push('### Country');
  out.push('');
  out.push(distTable(patterns.country.distribution, tally(bots, (b) => b.country), count));
  out.push('');

  // Bands
  out.push('### Skill bands');
  out.push('');
  const bandGen = tally(bots, (b) => BAND_LABELS[b.skillBand]!);
  const bandTotalW = patterns.skill.bandWeights.reduce((a, b) => a + b, 0);
  out.push('| band | target | generated |');
  out.push('|---|---|---|');
  for (let i = 0; i < BAND_LABELS.length; i++) {
    out.push(`| ${BAND_LABELS[i]} | ${((patterns.skill.bandWeights[i]! / bandTotalW) * 100).toFixed(1)}% | ${pct(bandGen.get(BAND_LABELS[i]!) ?? 0, count)} |`);
  }
  out.push('');

  // Schedules
  out.push('### Schedule archetypes (per-user sessionization, §1.3)');
  out.push('');
  out.push(`Archetypes are clustered from **per-user** activity: each of the`);
  out.push(`${patterns.activity.usersClustered} real players' match-start sequences was segmented into sessions`);
  out.push('on 20-minute gaps, and each user assigned to an hour-band archetype by modal hour. The');
  out.push('daily cap is drawn JOINTLY from the chosen archetype\'s own cap quantiles, so a night-owl');
  out.push('can never receive a high day cap. The aggregate histogram (below) is disclosure only.');
  out.push('');
  const schedGen = tally(bots, (b) => b.schedule.archetype);
  const schedTotalW = patterns.activity.scheduleArchetypes.reduce((a, s) => a + s.weight, 0);
  out.push('| archetype | window | target | generated | cap p50/p90 |');
  out.push('|---|---|---|---|---|');
  for (const s of patterns.activity.scheduleArchetypes) {
    const p50 = s.dailyCapQuantiles.find(([c]) => c >= 0.5)?.[1] ?? '';
    const p90 = s.dailyCapQuantiles.find(([c]) => c >= 0.9)?.[1] ?? '';
    const endLabel = s.endHour >= 24 ? `0${Math.floor(s.endHour) - 24}:${String(Math.round((s.endHour % 1) * 60)).padStart(2, '0')}` : `${s.endHour}:00`;
    out.push(`| ${s.key} | ${s.startHour}:00–${endLabel} | ${((s.weight / schedTotalW) * 100).toFixed(1)}% | ${pct(schedGen.get(s.key) ?? 0, count)} | ${p50}/${p90} |`);
  }
  out.push('');

  // Joint cap-by-archetype: prove night-owls never get high caps.
  out.push('### Daily match cap by archetype (joint sampling check)');
  out.push('');
  out.push(`Caps are clamped to a hard ceiling of **${DAILY_CAP_CEILING}** matches/day — OVERRIDDEN, not`);
  out.push('measured. Real players have a heavy tail (measured archetype p99s reach ~34, max ~120/day);');
  out.push('we deliberately do not mimic it, because a cap is a worst-case ceiling on an');
  out.push('always-available synthetic identity and a bot playing dozens of matches a day would be');
  out.push('conspicuous on the leaderboard and inflate matchmaking load. Central mass is preserved.');
  out.push('');
  const allCaps = bots.map((b) => b.dailyCap);
  const clamped = patterns.activity.scheduleArchetypes.length
    ? bots.filter((b) => {
        const arch = patterns.activity.scheduleArchetypes.find((s) => s.key === b.schedule.archetype);
        const top = arch ? Math.max(...arch.dailyCapQuantiles.map(([, v]) => v)) : 0;
        return top > DAILY_CAP_CEILING && b.dailyCap === DAILY_CAP_CEILING;
      }).length
    : 0;
  out.push(`Max generated cap: **${Math.max(...allCaps)}** (ceiling ${DAILY_CAP_CEILING}); bots sitting at the ceiling: ${clamped}.`);
  out.push('');
  out.push('| archetype | max generated cap | mean cap |');
  out.push('|---|---|---|');
  for (const s of patterns.activity.scheduleArchetypes) {
    const members = bots.filter((b) => b.schedule.archetype === s.key);
    const caps = members.map((b) => b.dailyCap);
    const maxCap = caps.length ? Math.max(...caps) : 0;
    const meanCap = caps.length ? (caps.reduce((a, b) => a + b, 0) / caps.length).toFixed(1) : '—';
    out.push(`| ${s.key} | ${maxCap} | ${meanCap} |`);
  }
  out.push('');

  // Sparsity checks
  const clubCount = bots.filter((b) => b.favoriteClub).length;
  const avatarCount = bots.filter((b) => b.avatarCustomization).length;
  const renameCount = bots.filter((b) => b.willRename).length;
  out.push('### Sparse fields (mimicking real coverage)');
  out.push('');
  out.push(`- favorite_club non-null: measured ${(patterns.club.nonNullRate * 100).toFixed(2)}%, generated ${pct(clubCount, count)}`);
  out.push(`- avatarCustomization present: generated ${pct(avatarCount, count)} (real coverage is sparse)`);
  out.push(`- will rename over season: generated ${pct(renameCount, count)} (target ${(patterns.rename.lifetimeRate * 100).toFixed(0)}%)`);
  out.push('');

  // Sample of 30 identities
  out.push('## Sample of 30 generated identities');
  out.push('');
  out.push('| # | nickname | country | city | club | band | cap | schedule | rename |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  const step = Math.max(1, Math.floor(count / 30));
  let shown = 0;
  for (let i = 0; i < bots.length && shown < 30; i += step, shown++) {
    const b = bots[i]!;
    out.push(`| ${b.index} | ${b.nickname} | ${b.country} | ${b.homeCity ?? ''} | ${b.favoriteClub ?? ''} | ${BAND_LABELS[b.skillBand]} | ${b.dailyCap} | ${b.schedule.archetype} | ${b.willRename ? 'yes' : ''} |`);
  }
  out.push('');

  // Full table note
  out.push('## Full roster');
  out.push('');
  out.push(`All ${count} rows are in the accompanying \`roster.csv\` (same seed, same run).`);
  out.push('');

  // Invariants that creation will enforce
  out.push('## Invariants the creation script will enforce post-write');
  out.push('');
  out.push('- Exactly this many `users` rows with `is_ai=true`, `ai_kind=\'persistent\'`.');
  out.push('- Every roster user has `coins=0`, `tickets=0`, `tickets_refill_started_at=NULL`.');
  out.push('- Zero `user_identities` rows for any roster user (bots cannot authenticate).');
  out.push('- Every roster user has a `ranked_profiles` row: `rp=450`, `placement_status=\'unplaced\'`.');
  out.push('- Every roster user has a `synthetic_player_profiles` row tagged with the generation batch.');
  out.push('- All nicknames unique (case-insensitive) and absent from the frozen exclusion set;');
  out.push('  a live final-collision re-check runs against current data as a separate pass.');
  out.push('');

  return out.join('\n') + '\n';
}
