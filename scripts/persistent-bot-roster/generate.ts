/**
 * Dry-run generator CLI. Reads patterns.json, generates the deterministic
 * roster, and writes: REPORT.md (approval gate), roster.csv (full table), and
 * roster.manifest.json (seed + report sha256 + patterns sha256, for the
 * creation script). NOTHING is written to any database.
 *
 * Usage:
 *   tsx scripts/persistent-bot-roster/generate.ts \
 *     --seed 1234567 [--count 1000] \
 *     [--patterns scripts/persistent-bot-roster/patterns.json] \
 *     [--out-dir scripts/persistent-bot-roster/out]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RosterPatterns } from './patterns.js';
import { generateRoster } from './roster.js';
import { buildCandidate } from './name-generator.js';
import { fieldRng } from './prng.js';
import { renderCsv, renderReport } from './report.js';
import { rosterDigest, sha256, type RosterManifest } from './manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function argVal(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function requireSafeSeed(raw: string | undefined): number {
  if (!raw) throw new Error('--seed <integer> is required');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new Error(`--seed must be a non-negative safe integer (< 2^53); got ${raw}`);
  }
  return n;
}

/** Probe effective name space by drawing many independent candidates. */
function probeEffectiveSpace(patterns: RosterPatterns, sampleSize = 5000): { distinctSampled: number; sampleSize: number } {
  const seen = new Set<string>();
  for (let i = 0; i < sampleSize; i++) {
    const rng = fieldRng(999983, i, 'probe');
    const name = buildCandidate({ rng, patterns: patterns.name, attempt: 0 });
    seen.add(name.normalize('NFC').toLowerCase());
  }
  return { distinctSampled: seen.size, sampleSize };
}

function main() {
  const seed = requireSafeSeed(argVal('--seed'));
  const count = Number(argVal('--count', '1000'));
  if (!Number.isInteger(count) || count <= 0) throw new Error('--count must be a positive integer');

  const patternsPath = path.resolve(
    process.cwd(),
    argVal('--patterns', path.join(__dirname, 'patterns.json'))!,
  );
  const outDir = path.resolve(process.cwd(), argVal('--out-dir', path.join(__dirname, 'out'))!);
  mkdirSync(outDir, { recursive: true });

  const patternsRaw = readFileSync(patternsPath, 'utf8');
  const patterns = JSON.parse(patternsRaw) as RosterPatterns;
  const patternsSha = sha256(patternsRaw);

  const bots = generateRoster({ seed, count, patterns });

  // Sanity: all mutually unique (case-insensitive) and none in the exclusion set.
  const keys = new Set<string>();
  const exclusion = new Set(patterns.exclusion.names);
  for (const b of bots) {
    const k = b.nickname.normalize('NFC').toLowerCase();
    if (keys.has(k)) throw new Error(`Duplicate generated nickname: ${b.nickname}`);
    if (exclusion.has(k)) throw new Error(`Generated nickname collides with exclusion set: ${b.nickname}`);
    keys.add(k);
  }

  const rosterSha = rosterDigest(bots);
  const effectiveSpaceProbe = probeEffectiveSpace(patterns);
  const report = renderReport({ seed, count, patterns, bots, effectiveSpaceProbe, rosterSha });
  const reportSha = sha256(report);
  const csv = renderCsv(bots);

  const reportPath = path.join(outDir, 'REPORT.md');
  const csvPath = path.join(outDir, 'roster.csv');
  const manifestPath = path.join(outDir, 'roster.manifest.json');

  const manifest: RosterManifest = {
    schemaVersion: 2,
    seed,
    count,
    reportSha256: reportSha,
    patternsSha256: patternsSha,
    exclusionSha256: patterns.exclusion.sha256,
    rosterSha256: rosterSha,
    generatedAt: new Date().toISOString(),
    maxNameAttempts: Math.max(...bots.map((b) => b.nameAttempts)),
  };

  writeFileSync(reportPath, report);
  writeFileSync(csvPath, csv);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  process.stdout.write(`Wrote ${reportPath}\n`);
  process.stdout.write(`Wrote ${csvPath}\n`);
  process.stdout.write(`Wrote ${manifestPath}\n`);
  process.stdout.write(`\nREPORT sha256 (pass to create.ts --approved-report):\n  ${reportSha}\n`);
  process.stdout.write(`Roster digest (bound in manifest): ${rosterSha}\n`);
  process.stdout.write(`Seed: ${seed}\n`);
  process.stdout.write(`Max name-generation attempts for any bot: ${Math.max(...bots.map((b) => b.nameAttempts))}\n`);
  process.stdout.write(`Effective name space probe: ${effectiveSpaceProbe.distinctSampled}/${effectiveSpaceProbe.sampleSize} unique\n`);
}

main();
