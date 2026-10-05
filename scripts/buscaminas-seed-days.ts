/**
 * Seeds the Buscaminas days (boards + answers) into buscaminas_days from the content
 * pipeline's full day files, in ONE transaction.
 *
 *   npm run buscaminas:seed -- [<daysDir>] [--dry-run] [--allow-correction] [--allow-pool-overlap] [--target staging|production]
 *
 * <daysDir> holds YYYY-MM-DD.json full day files (default: the sibling web checkout's
 * scripts/buscaminas/full/days, i.e. ../buscaminas-web or ../frontend-web-next). Every file is
 * validated (16 cards, 12 correct, 4 locales, card art under /buscaminas/v1/p/, contentVersion =
 * answer hash, contiguous days) before the database is touched. The files may be the whole calendar
 * or only the days to append: stored and supplied days together must run unbroken from the launch day.
 *
 * Prints each day as new / changed / unchanged. A day that already has runs keeps its answers
 * unless --allow-correction is passed (the correction must then change contentVersion). A round whose
 * category is in the duel pool is refused inside the write (--allow-pool-overlap: local databases only).
 * A non-local DATABASE_URL is refused unless --target names its Supabase project.
 */
import 'dotenv/config';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  assertCalendar, parseDayFile, resolveSeedTarget, seedDays, toDayRow, PROJECT_REFS, type SeedEntry, type SeedTargetName,
} from '../src/modules/buscaminas/buscaminas.seed.js';

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Args {
  dir: string | undefined;
  dryRun: boolean;
  allowCorrection: boolean;
  allowPoolOverlap: boolean;
  target: SeedTargetName | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: undefined, dryRun: false, allowCorrection: false, allowPoolOverlap: false, target: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--allow-correction') args.allowCorrection = true;
    else if (arg === '--allow-pool-overlap') args.allowPoolOverlap = true;
    else if (arg === '--target' || arg.startsWith('--target=')) {
      const value = arg === '--target' ? argv[++i] : arg.slice('--target='.length);
      if (!value || !(value in PROJECT_REFS)) throw new Error('--target must be staging or production');
      args.target = value as SeedTargetName;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else if (args.dir === undefined) args.dir = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  return args;
}

const dayFiles = (dir: string): string[] =>
  existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter((f) => DAY_FILE.test(f)).sort() : [];

function resolveSource(dir: string | undefined): string {
  if (dir) {
    const abs = resolve(dir);
    if (dayFiles(abs).length === 0) throw new Error(`No YYYY-MM-DD.json day files in ${abs}`);
    return abs;
  }
  const candidates = ['../buscaminas-web', '../frontend-web-next'].map((root) => join(backendRoot, root, 'scripts/buscaminas/full/days'));
  const found = candidates.find((candidate) => dayFiles(candidate).length > 0);
  if (!found) throw new Error(`No day files found (tried ${candidates.join(', ')}); pass <daysDir>`);
  return found;
}

function describe(entry: SeedEntry): string {
  const head = `${entry.day}  #${String(entry.number).padEnd(3)}`;
  if (entry.status === 'new') return `${head} new        v${entry.contentVersion}`;
  if (entry.status === 'unchanged') return `${head} unchanged  v${entry.contentVersion}`;
  const what = entry.answersChanged ? `answers v${entry.previousVersion} -> v${entry.contentVersion}` : 'board text only';
  return `${head} changed    ${what}${entry.runs > 0 ? ` (${entry.runs} runs)` : ''}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveSeedTarget(process.env.DATABASE_URL, args.target);
  const src = resolveSource(args.dir);
  const files = dayFiles(src);
  const days = files.map((file) => {
    const day = parseDayFile(file, JSON.parse(readFileSync(join(src, file), 'utf8')));
    if (`${day.day}.json` !== file) throw new Error(`${file}: day ${day.day} does not match the file name`);
    return day;
  });
  assertCalendar(days);
  console.log(`[buscaminas:seed] database: ${target.label}`);
  console.log(`[buscaminas:seed] source: ${src} (${days.length} days, ${days[0].day} … ${days[days.length - 1].day}, all valid)`);

  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1, prepare: false, connect_timeout: 15, onnotice: () => undefined, ssl: target.kind === 'local' ? false : 'require',
  });
  try {
    if (args.allowPoolOverlap && target.kind !== 'local') throw new Error('--allow-pool-overlap is for local databases only');
    const plan = await seedDays(sql, days.map(toDayRow), { dryRun: args.dryRun, allowCorrection: args.allowCorrection, allowPoolOverlap: args.allowPoolOverlap });
    for (const entry of plan.entries) console.log(`  ${describe(entry)}`);
    if (plan.extraDays.length > 0) console.log(`[buscaminas:seed] stored days not in the files (kept): ${plan.extraDays.length} (${plan.extraDays[0]} … ${plan.extraDays[plan.extraDays.length - 1]})`);
    const count = (status: SeedEntry['status']) => plan.entries.filter((e) => e.status === status).length;
    const writes = count('new') + count('changed');
    console.log(`[buscaminas:seed] ${count('new')} new, ${count('changed')} changed, ${count('unchanged')} unchanged — ${
      args.dryRun ? `dry run, nothing written (${writes} would be written)` : `${writes} written`}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(`[buscaminas:seed] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
