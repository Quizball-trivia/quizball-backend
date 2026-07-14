/* eslint-disable no-console */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface CapacityArgs {
  target: 'staging' | 'local';
  levels: number[];
  durationSec: number;
  cooldownSec: number;
  perPlayerRps: number;
  socketRatio: number;
  rampSec: number;
  flapRate: number;
  continueOnFail: boolean;
}

interface ChildReport {
  verdict?: { ok?: boolean; violations?: string[] };
  database?: { peak?: { utilizationPct?: number; total?: number; maxConnections?: number } };
  http?: { routes?: Array<{ p95: number; p99: number; errorRatePct: number }> };
}

function value(argv: string[], key: string): string | undefined {
  const exact = argv.indexOf(`--${key}`);
  if (exact >= 0) return argv[exact + 1]?.startsWith('--') ? 'true' : argv[exact + 1] ?? 'true';
  const prefix = `--${key}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function positiveNumber(argv: string[], key: string, fallback: number): number {
  const raw = value(argv, key);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${key} must be positive`);
  return parsed;
}

export function parseCapacityArgs(argv: string[]): CapacityArgs {
  const target = (value(argv, 'target') ?? 'staging') as CapacityArgs['target'];
  if (target !== 'staging' && target !== 'local') throw new Error('--target must be staging or local');
  const levels = (value(argv, 'levels') ?? '25,50,100,200,350,500,750')
    .split(',')
    .map(Number)
    .filter((level) => Number.isInteger(level) && level > 0);
  if (levels.length === 0) throw new Error('--levels must contain positive integers');
  return {
    target,
    levels: [...new Set(levels)].sort((a, b) => a - b),
    durationSec: positiveNumber(argv, 'duration', 300),
    cooldownSec: positiveNumber(argv, 'cooldown', 30),
    perPlayerRps: positiveNumber(argv, 'per-player-rps', 0.5),
    socketRatio: positiveNumber(argv, 'socket-ratio', 1),
    rampSec: positiveNumber(argv, 'ramp-s', 60),
    flapRate: Math.max(0, Number(value(argv, 'flap-rate') ?? 0)),
    continueOnFail: value(argv, 'continue-on-fail') === 'true',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function runChild(args: string[]): Promise<number> {
  const tsx = resolve(REPO_ROOT, 'node_modules/.bin/tsx');
  return new Promise((resolveExit, reject) => {
    const child = spawn(tsx, args, { cwd: REPO_ROOT, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

async function main(): Promise<void> {
  const args = parseCapacityArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = resolve(REPO_ROOT, 'scripts/chaos/reports', `capacity-${stamp}`);
  mkdirSync(reportDir, { recursive: true });

  console.log('═'.repeat(72));
  console.log('QUIZBALL CAPACITY LADDER (PRODUCTION TARGET IS BLOCKED)');
  console.log(`levels=${args.levels.join(',')} target=${args.target} duration=${args.durationSec}s/level`);
  console.log('═'.repeat(72));

  const results: Array<{
    players: number;
    sockets: number;
    totalRps: number;
    ok: boolean;
    exitCode: number;
    violations: string[];
    dbPeakUtilizationPct: number | null;
    reportPath: string;
  }> = [];

  for (let index = 0; index < args.levels.length; index += 1) {
    const players = args.levels[index]!;
    const sockets = Math.max(1, Math.round(players * args.socketRatio));
    const totalRps = Math.max(1, Math.round(players * args.perPlayerRps));
    const reportPath = resolve(reportDir, `${String(players).padStart(4, '0')}-players.json`);
    console.log(`\n▶ ${players} players: ${sockets} sockets + ${totalRps} weighted HTTP rps`);

    const childArgs = [
      'scripts/chaos/run.ts',
      `--target=${args.target}`,
      `--users=${Math.max(players, sockets)}`,
      `--sockets=${sockets}`,
      `--total-rps=${totalRps}`,
      `--duration=${args.durationSec}`,
      `--ramp-s=${Math.min(args.rampSec, args.durationSec / 2)}`,
      '--login-storm',
      `--login-ramp-s=${Math.min(args.rampSec, args.durationSec / 2)}`,
      `--flap-rate=${args.flapRate}`,
      '--flap-stage=search,draft,gate,match',
      `--report=${reportPath}`,
    ];
    const exitCode = await runChild(childArgs);
    let report: ChildReport = {};
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8')) as ChildReport;
    } catch (error) {
      throw new Error(`capacity child did not produce ${reportPath}: ${String(error)}`);
    }
    const ok = exitCode === 0 && report.verdict?.ok === true;
    results.push({
      players,
      sockets,
      totalRps,
      ok,
      exitCode,
      violations: report.verdict?.violations ?? [],
      dbPeakUtilizationPct: report.database?.peak?.utilizationPct ?? null,
      reportPath,
    });

    if (!ok && !args.continueOnFail) {
      console.log(`Stopping at first failed level (${players} players).`);
      break;
    }
    if (index < args.levels.length - 1 && args.cooldownSec > 0) {
      console.log(`Cooling down for ${args.cooldownSec}s…`);
      await sleep(args.cooldownSec * 1000);
    }
  }

  const passing = results.filter((result) => result.ok);
  const firstFailure = results.find((result) => !result.ok) ?? null;
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    args,
    lastPassingPlayers: passing.at(-1)?.players ?? null,
    firstFailingPlayers: firstFailure?.players ?? null,
    interpretation: firstFailure
      ? `Sustained capacity is below ${firstFailure.players} players under this traffic model.`
      : `Capacity is at least ${passing.at(-1)?.players ?? 0} players; test higher levels to find the ceiling.`,
    results,
  };
  const summaryPath = resolve(reportDir, 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log('\n' + '═'.repeat(72));
  console.table(results.map((result) => ({
    players: result.players,
    sockets: result.sockets,
    httpRps: result.totalRps,
    pass: result.ok,
    dbPeakPct: result.dbPeakUtilizationPct,
    violations: result.violations.join('; '),
  })));
  console.log(summary.interpretation);
  console.log(`Capacity summary: ${summaryPath}`);
  if (passing.length === 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
