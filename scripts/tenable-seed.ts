/**
 * Seeds Football Tenable's lists: the solo days or the room pool. Dry run unless --write.
 *
 *   npx tsx scripts/tenable-seed.ts --days <days.json> | --pool <pool.json> | --entities <release.json> | --player-meta <meta.json>
 *     --target local|staging|production [--write] [--allow-correction]
 *
 * The files are produced by the private builder (~/dev/quizball-private/tenable): {days: [{day, list}]} contiguous from
 * the calendar's first day, or {lists: [...]}. Every list's entity release must already be seeded. Prints ids and counts
 * only, never an answer.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';
import { parseDaysFile, parsePoolFile, seedDays, seedEntityRelease, seedPlayerMeta, seedPool } from '../src/modules/tenable/tenable.seed.js';

function parseArgs(argv: string[]) {
  const args: { days?: string; pool?: string; entities?: string; playerMeta?: string; target?: PistasSeedTarget; write: boolean; allowCorrection: boolean } = { write: false, allowCorrection: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]);
    if (arg === '--write') args.write = true;
    else if (arg === '--allow-correction') args.allowCorrection = true;
    else if (arg.startsWith('--days')) args.days = value();
    else if (arg.startsWith('--pool')) args.pool = value();
    else if (arg.startsWith('--entities')) args.entities = value();
    else if (arg.startsWith('--player-meta')) args.playerMeta = value();
    else if (arg.startsWith('--target')) {
      const target = value();
      if (!SEED_TARGETS.includes(target as PistasSeedTarget)) throw new Error('--target must be local, staging or production');
      args.target = target as PistasSeedTarget;
    } else throw new Error(`Unknown argument ${arg}`);
  }
  if ([args.days, args.pool, args.entities, args.playerMeta].filter(Boolean).length !== 1) throw new Error('Pass exactly one of --days, --pool, --entities or --player-meta <file>');
  return args;
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch {
    throw new Error(`${path}: unreadable or not JSON`);
  }
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolvePistasSeedTarget(process.env.DATABASE_URL, args.target);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, connect_timeout: 15, onnotice: () => undefined, ssl: target.kind === 'local' ? false : 'require' });
  try {
    if (args.playerMeta) {
      const outcome = await seedPlayerMeta(sql, readJson(args.playerMeta), { dryRun: !args.write });
      console.log(`Player qualifiers for ${outcome.release} -> ${target.label}: ${outcome.fresh} new, ${outcome.unchanged} unchanged${args.write || outcome.fresh === 0 ? '' : ' (dry run, add --write)'}.`);
    } else if (args.entities) {
      const outcome = await seedEntityRelease(sql, readJson(args.entities), { dryRun: !args.write });
      console.log(`Entity release ${outcome.release} (${Object.entries(outcome.counts).map(([k, n]) => `${n} ${k}`).join(', ')}) -> ${target.label}: ${outcome.status}${args.write || outcome.status === 'unchanged' ? '' : ' (dry run, add --write)'}.`);
    } else if (args.days) {
      const days = parseDaysFile(readJson(args.days));
      console.log(`Tenable days: ${days.length} (${days[0].day} to ${days[days.length - 1].day}) -> ${target.label}`);
      const outcome = await seedDays(sql, days, { dryRun: !args.write, allowCorrection: args.allowCorrection });
      console.log(`${args.write ? 'Written' : 'Dry run (add --write)'}: ${outcome.fresh} new, ${outcome.unchanged} unchanged, ${outcome.corrected} corrected${outcome.unranked ? `, ${outcome.unranked} ranked runs unranked` : ''}.`);
    } else {
      const lists = parsePoolFile(readJson(args.pool!));
      console.log(`Tenable room lists: ${lists.length} -> ${target.label}`);
      const outcome = await seedPool(sql, lists, { dryRun: !args.write });
      console.log(`${args.write ? 'Written' : 'Dry run (add --write)'}: ${outcome.fresh} new, ${outcome.unchanged} unchanged.`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
