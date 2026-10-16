/**
 * Seeds the Football Horserace daily races (football_race_days). Dry run unless --write.
 *
 *   npx tsx scripts/football-race-seed-days.ts --file <days.json> --target local|staging|production [--write] [--allow-correction]
 *
 * <days.json> is {release, days: [{day, number, race}]}, built by the private pipeline (build_days.ts). Every race is
 * parsed with the server's day schema; its release must already be published here (football-race-seed-release.ts).
 * A day already seeded with other content is refused unless --allow-correction, which unranks every run of that day
 * (finished ones too: their score was for other content); /start then restarts each unfinished run on the new race. Takes the content lock shared with the release seed. Prints counts only, never a value.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { z } from 'zod';
import { dayRaceSchema } from '../src/modules/football-race/football-race.types.js';
import { CONTENT_START, LAST_DAY } from '../src/modules/football-race/football-race.days.js';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';

const FOOTBALL_RACE_CONTENT_LOCK = 'football_race_content';
const fileSchema = z.object({
  release: z.string().min(3).max(60),
  days: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), number: z.number().int().positive(), race: z.unknown() }).strict()).min(1).max(500),
}).strict();

/** A day's content version: a hash of its race (positive, below 2^32). */
const versionOf = (race: unknown) => (parseInt(createHash('sha256').update(JSON.stringify(race)).digest('hex').slice(0, 8), 16) % 0xfffffffe) + 1;

function parseArgs(argv: string[]) {
  const args: { file?: string; target?: PistasSeedTarget; write: boolean; allowCorrection: boolean } = { write: false, allowCorrection: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]);
    if (arg === '--write') args.write = true;
    else if (arg === '--allow-correction') args.allowCorrection = true;
    else if (arg.startsWith('--file')) args.file = value();
    else if (arg.startsWith('--target')) {
      const target = value();
      if (!SEED_TARGETS.includes(target as PistasSeedTarget)) throw new Error('--target must be local, staging or production');
      args.target = target as PistasSeedTarget;
    } else throw new Error(`Unknown argument ${arg}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolvePistasSeedTarget(process.env.DATABASE_URL, args.target);
  if (!args.file) throw new Error('--file <days.json> is required');
  const file = fileSchema.parse(JSON.parse(readFileSync(resolve(args.file), 'utf8')));
  const days = file.days.map((d) => {
    const race = dayRaceSchema.safeParse(d.race);
    if (!race.success) throw new Error(`${d.day}: ${race.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    if (race.data.data.release !== file.release) throw new Error(`${d.day}: race of release ${race.data.data.release}, file says ${file.release}`);
    if (d.day < CONTENT_START || d.day > LAST_DAY) throw new Error(`${d.day} is outside the calendar (${CONTENT_START} → ${LAST_DAY})`);
    return { day: d.day, number: d.number, race: race.data, version: versionOf(race.data) };
  });
  if (new Set(days.map((d) => d.day)).size !== days.length) throw new Error('Duplicate day in the file');
  console.log(`Football Horserace days: ${days.length} (${days[0].day} → ${days.at(-1)!.day}), release ${file.release} -> ${target.label}`);
  if (!args.write) {
    console.log('Dry run: nothing written (add --write).');
    return;
  }
  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1, prepare: false, connect_timeout: 15, onnotice: () => undefined, ssl: target.kind === 'local' ? false : 'require',
  });
  try {
    const result = await sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '120s'`;
      await tx`SET LOCAL idle_in_transaction_session_timeout = '120s'`;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${FOOTBALL_RACE_CONTENT_LOCK}))`;
      const [release] = await tx<Array<{ release: string }>>`SELECT release FROM football_race_releases WHERE release = ${file.release}`;
      if (!release) throw new Error(`Release ${file.release} is not published here; run football-race-seed-release first`);
      const existing = new Map((await tx<Array<{ day: string; content_version: string }>>`
        SELECT day::text AS day, content_version FROM football_race_days WHERE day = ANY(${days.map((d) => d.day)}::date[])`).map((r) => [r.day, Number(r.content_version)]));
      const changed = days.filter((d) => existing.has(d.day) && existing.get(d.day) !== d.version);
      if (changed.length > 0 && !args.allowCorrection) throw new Error(`${changed.length} day(s) already seeded with other content (first ${changed[0].day}); add --allow-correction`);
      let written = 0;
      let unranked = 0;
      for (const d of days) {
        if (existing.get(d.day) === d.version) continue;
        await tx`
          INSERT INTO football_race_days (day, number, content_version, race) VALUES (${d.day}, ${d.number}, ${d.version}, ${tx.json(d.race as never)})
          ON CONFLICT (day) DO UPDATE SET number = EXCLUDED.number, content_version = EXCLUDED.content_version, race = EXCLUDED.race, updated_at = now()`;
        if (existing.has(d.day)) unranked += (await tx`UPDATE football_race_runs SET ranked = false WHERE day = ${d.day} AND ranked`).count;
        written += 1;
      }
      return { written, corrected: changed.length, unranked };
    });
    console.log(`Written: ${result.written} day(s)${result.corrected ? `, ${result.corrected} corrected (${result.unranked} ranked run(s) unranked)` : ''}.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
