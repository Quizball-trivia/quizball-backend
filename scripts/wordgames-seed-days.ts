/**
 * Seeds the days of a word-game daily (shared_player_days or name_chain_days). Dry run unless --write.
 *
 *   npx tsx scripts/wordgames-seed-days.ts --file <days.json> --target local|staging|production [--write] [--allow-correction]
 *
 * <days.json> is {game: "shared_player"|"name_chain", days: [{day, number, content}]}, produced by the private builder
 * (~/dev/quizball-private/turkish-word-games), contiguous from the game's first content day and of one footballer
 * release, which must already be seeded (scripts/wordgames-seed-release.ts). Prints counts only, never a name.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';
import { parseDaysFile, seedDays } from '../src/modules/wordgame-daily/wordgame-daily.seed.js';

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
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(args.file), 'utf8'));
  } catch {
    throw new Error(`${args.file}: unreadable or not JSON`);
  }
  const input = parseDaysFile(raw);
  console.log(`${input.game} days: ${input.days.length} (${input.days[0].day} to ${input.days[input.days.length - 1].day}), release ${input.releases.join(' then ')} -> ${target.label}`);
  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1, prepare: false, connect_timeout: 15, onnotice: () => undefined, ssl: target.kind === 'local' ? false : 'require',
  });
  try {
    const outcome = await seedDays(sql, input, { dryRun: !args.write, allowCorrection: args.allowCorrection });
    console.log(`${args.write ? 'Written' : 'Dry run (add --write)'}: ${outcome.fresh} new, ${outcome.unchanged} unchanged, ${outcome.corrected} corrected${outcome.unranked ? `, ${outcome.unranked} ranked runs unranked` : ''}.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
