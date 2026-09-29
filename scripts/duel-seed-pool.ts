/**
 * Seeds a private duel-only pool (duel_pool) for one game. Dry run unless --write.
 *
 *   npm run duel:seed -- --game pistas|buscaminas --file <pool.json> --target local|staging|production [--write] [--allow-overlap]
 *
 * <pool.json> is {game, items: [...]}, items shaped like one round of the game (Pistas: {id, difficulty,
 * clues x10, answer}; Buscaminas: {id, difficulty, prompt, cards x16, ok x12}). Every item is validated, and
 * the pool is refused when any item overlaps a stored daily (a Pistas player who is a daily answer, a
 * Buscaminas category a daily uses) — duel packs are harvestable, dailies must stay secret.
 * --allow-overlap is accepted for --target local only (development pools built from daily files).
 * Prints counts only, never an answer or a clue.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { findDailyOverlap, parsePoolFile, writePool } from '../src/modules/duel/duel.seed.js';
import { DUEL_GAMES, type DuelGameId } from '../src/modules/duel/duel.types.js';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';

interface Args { game?: DuelGameId; file?: string; target?: PistasSeedTarget; write: boolean; allowOverlap: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { write: false, allowOverlap: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const eq = arg.indexOf('=');
      if (eq > 0) return arg.slice(eq + 1);
      i += 1;
      return argv[i];
    };
    if (arg === '--write') args.write = true;
    else if (arg === '--allow-overlap') args.allowOverlap = true;
    else if (arg.startsWith('--game')) {
      const game = value();
      if (!DUEL_GAMES.includes(game as DuelGameId)) throw new Error('--game must be pistas or buscaminas');
      args.game = game as DuelGameId;
    } else if (arg.startsWith('--file')) args.file = value();
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
  if (!args.game) throw new Error('--game is required');
  if (!args.file) throw new Error('--file <pool.json> is required');
  if (args.allowOverlap && target.kind !== 'local') throw new Error('--allow-overlap is for --target local only');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(args.file), 'utf8'));
  } catch {
    throw new Error(`${args.file}: unreadable or not JSON`);
  }
  const rows = parsePoolFile(args.game, raw);
  const counts = rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.difficulty]: (acc[row.difficulty] ?? 0) + 1 }), {});
  console.log(`${args.game} pool: ${rows.length} items ${JSON.stringify(counts)} -> ${target.label}`);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  try {
    const { overlapping } = await findDailyOverlap(sql, args.game, rows);
    if (overlapping.length > 0) {
      const message = `${overlapping.length} item(s) overlap a daily (indexes ${overlapping.slice(0, 20).join(', ')})`;
      if (!args.allowOverlap) throw new Error(`${message}; refused`);
      console.warn(`WARNING (local only): ${message}`);
    }
    if (!args.write) {
      console.log('Dry run: nothing written (add --write).');
      return;
    }
    const written = await writePool(sql, args.game, rows);
    console.log(`Written: ${written.inserted} new, ${written.updated} updated.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
