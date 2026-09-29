/**
 * Seeds the Pistas futboleras days (clues + answers) into pistas_days from the private content
 * pipeline's day files, in ONE transaction. Dry run unless --write.
 *
 *   npm run pistas:seed -- --file <daysDir> --target local|staging|production [--write] [--allow-correction]
 *
 * <daysDir> holds YYYY-MM-DD.json day files ({day, number, rounds: [{id, difficulty, answer: {display,
 * accepted}, clues: [{kind, icon, text}] x10, source}] x10}). Every file is validated (10 rounds x 10
 * clues, 4 locales, every display name normalises into `accepted`, no clue names an accepted answer,
 * contiguous days from the first content day covering the calendar) before the database is touched.
 * `source` and any other unknown field are dropped: provenance never reaches the database.
 *
 * Prints each day as new / changed / unchanged with its content version and run counts, never an
 * answer or a clue. A day whose content changes while it has runs is refused unless
 * --allow-correction, which unranks that day's runs (their state is kept).
 * --target must match DATABASE_URL: local for a local database, else the exact Supabase project.
 */
import 'dotenv/config';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import {
  assertCalendar, duelPoolOverlap, parseDayFile, resolvePistasSeedTarget, seedDays, SEED_TARGETS, toDayRow, type PistasSeedTarget, type SeedEntry,
} from '../src/modules/pistas/pistas.seed.js';

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

interface Args {
  dir: string | undefined;
  write: boolean;
  allowCorrection: boolean;
  /** Local development only: the dev duel pool reuses future daily players. */
  allowPoolOverlap: boolean;
  target: PistasSeedTarget | undefined;
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
      if (!value || !SEED_TARGETS.includes(value as PistasSeedTarget)) throw new Error('--target must be local, staging or production');
      args.target = value as PistasSeedTarget;
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
  const target = resolvePistasSeedTarget(process.env.DATABASE_URL, args.target);
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
  console.log(`[pistas:seed] database: ${target.label}`);
  console.log(`[pistas:seed] source: ${src} (${days.length} days, ${days[0].day} … ${days[days.length - 1].day}, all valid)`);

  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1, prepare: false, connect_timeout: 15, onnotice: () => undefined, ssl: target.kind === 'local' ? false : 'require',
  });
  try {
    if (args.allowPoolOverlap && target.kind !== 'local') throw new Error('--allow-pool-overlap is for --target local only');
    const overlap = await duelPoolOverlap(sql, days.map(toDayRow));
    if (overlap > 0) {
      if (!args.allowPoolOverlap) throw new Error(`${overlap} daily player(s) are in the duel pool; refused (duel content is harvestable)`);
      console.warn(`WARNING (local only): ${overlap} daily player(s) are also in the local dev duel pool`);
    }
    const plan = await seedDays(sql, days.map(toDayRow), { dryRun: !args.write, allowCorrection: args.allowCorrection });
    for (const entry of plan.entries) console.log(`  ${describe(entry)}`);
    if (plan.extraDays.length > 0) console.log(`[pistas:seed] stored days not in the files (kept): ${plan.extraDays.join(', ')}`);
    const count = (status: SeedEntry['status']) => plan.entries.filter((e) => e.status === status).length;
    const writes = count('new') + count('changed');
    console.log(`[pistas:seed] ${count('new')} new, ${count('changed')} changed, ${count('unchanged')} unchanged — ${
      args.write ? `${writes} written` : `dry run, nothing written (${writes} would be written; pass --write)`}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(`[pistas:seed] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
