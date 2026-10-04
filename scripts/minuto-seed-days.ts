/**
 * Seeds the "¿En qué minuto?" days (10 goals each) into minuto_days from the private content pipeline's day files,
 * in ONE transaction. Dry run unless --write.
 *
 *   npm run minuto:seed -- --file <daysDir> --target local|staging|production [--write] [--allow-correction]
 *
 * <daysDir> holds YYYY-MM-DD.json day files ({day, number, goals: [goal] x10}, goal = src/modules/minuto/minuto.goal.ts).
 * Every file is validated (the goal schema, no goal twice by id or fingerprint, one unbroken run of days) before the
 * database is touched; an unknown field is refused. The stored days are the calendar: a batch may re-supply stored
 * days and append the days after them, but never leave a hole, and a goal another day already published is refused.
 *
 * Prints each day as new / changed / unchanged with its content version and run counts, never a minute. A day whose
 * content changes while it has runs is refused unless --allow-correction, which unranks that day's runs. A goal that
 * is in the duel pool (now or ever) is refused, checked inside the write transaction.
 * --target must match DATABASE_URL: local for a local database, else the exact Supabase project.
 */
import 'dotenv/config';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import {
  assertCalendar, parseDayFile, seedDays, type SeedEntry,
} from '../src/modules/minuto/minuto.seed.js';
import { resolvePistasSeedTarget as resolveSeedTarget, SEED_TARGETS, type PistasSeedTarget as SeedTarget } from '../src/modules/pistas/pistas.seed.js';

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

interface Args {
  dir: string | undefined;
  write: boolean;
  allowCorrection: boolean;
  /** Local development only: a dev duel pool may repeat daily goals. */
  allowPoolOverlap: boolean;
  target: SeedTarget | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: undefined, write: false, allowCorrection: false, allowPoolOverlap: false, target: undefined };
  const valueOf = (arg: string, name: string, i: number): [string | undefined, number] =>
    (arg === name ? [argv[i + 1], i + 1] : [arg.slice(name.length + 1), i]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') args.write = true;
    else if (arg === '--allow-correction') args.allowCorrection = true;
    else if (arg === '--allow-pool-overlap') args.allowPoolOverlap = true;
    else if (arg === '--target' || arg.startsWith('--target=')) {
      const [value, at] = valueOf(arg, '--target', i);
      i = at;
      if (!value || !SEED_TARGETS.includes(value as SeedTarget)) throw new Error('--target must be local, staging or production');
      args.target = value as SeedTarget;
    } else if (arg === '--file' || arg.startsWith('--file=')) {
      const [value, at] = valueOf(arg, '--file', i);
      i = at;
      if (!value) throw new Error('--file needs a directory of day files');
      args.dir = value;
    } else throw new Error(`Unknown argument ${arg}`);
  }
  return args;
}

const dayFiles = (dir: string): string[] =>
  existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter((f) => DAY_FILE.test(f)).sort() : [];

function describe(entry: SeedEntry): string {
  const head = `${entry.day}  #${String(entry.number).padEnd(3)}`;
  if (entry.status === 'new') return `${head} new        v${entry.contentVersion}`;
  if (entry.status === 'unchanged') return `${head} unchanged  v${entry.contentVersion}${entry.runs > 0 ? ` (${entry.runs} runs)` : ''}`;
  const what = entry.contentChanged ? `content v${entry.previousVersion} -> v${entry.contentVersion}` : 'number only';
  const runs = entry.runs > 0 ? ` (${entry.runs} runs${entry.contentChanged ? `, ${entry.voids} ranked unranked` : ''})` : '';
  return `${head} changed    ${what}${runs}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // The host guard runs before any file is read or any connection is opened.
  const target = resolveSeedTarget(process.env.DATABASE_URL, args.target);
  if (!args.dir) throw new Error('--file <daysDir> is required');
  const src = resolve(args.dir);
  const files = dayFiles(src);
  if (files.length === 0) throw new Error(`No YYYY-MM-DD.json day files in ${src}`);
  const days = files.map((file) => {
    let raw: unknown;
    // A JSON syntax error quotes the text around it, which may be an answer: report the file only.
    try { raw = JSON.parse(readFileSync(join(src, file), 'utf8')); } catch { throw new Error(`${file}: not valid JSON`); }
    const day = parseDayFile(file, raw);
    if (`${day.day}.json` !== file) throw new Error(`${file}: day ${day.day} does not match the file name`);
    return day;
  });
  assertCalendar(days);
  console.log(`[minuto:seed] database: ${target.label}`);
  console.log(`[minuto:seed] source: ${src} (${days.length} days, ${days[0].day} … ${days[days.length - 1].day}, all valid)`);

  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1, prepare: false, connect_timeout: 15, onnotice: () => undefined, ssl: target.kind === 'local' ? false : 'require',
  });
  try {
    if (args.allowPoolOverlap && target.kind !== 'local') throw new Error('--allow-pool-overlap is for --target local only');
    const plan = await seedDays(sql, days, { dryRun: !args.write, allowCorrection: args.allowCorrection, allowPoolOverlap: args.allowPoolOverlap });
    if (plan.poolOverlap > 0) console.warn(`WARNING (local only): ${plan.poolOverlap} daily goal(s) also in the local dev duel pool`);
    for (const entry of plan.entries) console.log(`  ${describe(entry)}`);
    if (plan.extraDays.length > 0) console.log(`[minuto:seed] stored days not in the files (kept): ${plan.extraDays.length} (${plan.extraDays[0]} … ${plan.extraDays[plan.extraDays.length - 1]})`);
    const count = (status: SeedEntry['status']) => plan.entries.filter((e) => e.status === status).length;
    const writes = count('new') + count('changed');
    console.log(`[minuto:seed] ${count('new')} new, ${count('changed')} changed, ${count('unchanged')} unchanged — ${
      args.write ? `${writes} written` : `dry run, nothing written (${writes} would be written; pass --write)`}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(`[minuto:seed] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
