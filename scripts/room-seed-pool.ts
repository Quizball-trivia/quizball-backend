/**
 * Seeds the private room-game pool (room_pool) for one game. Dry run unless --write.
 *
 *   npx tsx scripts/room-seed-pool.ts --game aproximado --file <pool.json> --target local|staging|production [--write]
 *
 * <pool.json> is {game, items: [{item_id, difficulty, fingerprint, payload}]}, produced by the private generator
 * (~/dev/quizball-private/aproximado-pool), which keeps the pool disjoint from the public daily. Every payload is
 * validated against the game's schema. Prints counts only, never a value.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { z } from 'zod';
import { aproximadoItemSchema, ROOM_GAMES, ROOM_PACK_WANTED, type RoomGameId } from '../src/modules/room/room.types.js';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';

const rowSchema = z.object({
  item_id: z.string().min(1).max(64),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  fingerprint: z.string().min(8).max(64),
  payload: aproximadoItemSchema,
}).strict();
const SEED_BATCH = 300;
const fileSchema = z.object({ game: z.enum(ROOM_GAMES), items: z.array(rowSchema).min(30) }).strict();

function parseArgs(argv: string[]) {
  const args: { game?: RoomGameId; file?: string; target?: PistasSeedTarget; write: boolean } = { write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]);
    if (arg === '--write') args.write = true;
    else if (arg.startsWith('--game')) {
      const game = value();
      if (!ROOM_GAMES.includes(game as RoomGameId)) throw new Error(`--game must be one of ${ROOM_GAMES.join(', ')}`);
      args.game = game as RoomGameId;
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
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(args.file), 'utf8'));
  } catch {
    throw new Error(`${args.file}: unreadable or not JSON`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid pool: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  if (parsed.data.game !== args.game) throw new Error(`File is for ${parsed.data.game}, not ${args.game}`);
  const rows = parsed.data.items;
  for (const [field, pick] of [['item_id', (r: typeof rows[number]) => r.item_id], ['fingerprint', (r: typeof rows[number]) => r.fingerprint]] as const) {
    if (new Set(rows.map(pick)).size !== rows.length) throw new Error(`Duplicate ${field} in the pool`);
  }
  if (rows.some((r) => r.payload.id !== r.item_id)) throw new Error('payload.id must equal item_id');
  const counts = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.difficulty]: (acc[r.difficulty] ?? 0) + 1 }), {});
  console.log(`${args.game} room pool: ${rows.length} items ${JSON.stringify(counts)} -> ${target.label}`);
  // Every match deals ROOM_PACK_WANTED per difficulty; a pool short of one would fail at the first start.
  for (const [difficulty, needed] of Object.entries(ROOM_PACK_WANTED)) {
    if ((counts[difficulty] ?? 0) < needed) throw new Error(`Pool needs at least ${needed} ${difficulty} items (has ${counts[difficulty] ?? 0})`);
  }
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
      let inserted = 0;
      // A few hundred rows per statement: one round trip each (row by row, 900 round trips through the pooler took
      // long enough for it to drop the connection mid-transaction).
      for (let i = 0; i < rows.length; i += SEED_BATCH) {
        const batch = rows.slice(i, i + SEED_BATCH);
        const written = await tx<Array<{ inserted: boolean }>>`
          INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload)
          SELECT ${args.game!}, t.item_id, t.difficulty, t.fingerprint, p.payload
          FROM unnest(
            ${batch.map((r) => r.item_id)}::text[], ${batch.map((r) => r.difficulty)}::text[], ${batch.map((r) => r.fingerprint)}::text[]
          ) WITH ORDINALITY AS t(item_id, difficulty, fingerprint, n)
          JOIN jsonb_array_elements(${tx.json(batch.map((r) => r.payload) as never)}) WITH ORDINALITY AS p(payload, n) USING (n)
          ON CONFLICT (game, item_id) DO UPDATE SET difficulty = EXCLUDED.difficulty, payload = EXCLUDED.payload,
            fingerprint = EXCLUDED.fingerprint, updated_at = now()
          RETURNING (xmax = 0) AS inserted
        `;
        inserted += written.filter((row) => row.inserted).length;
      }
      // What a match can actually draw from: enabled rows only (a row disabled on purpose stays disabled). Short on
      // any difficulty: roll back rather than leave a pool that fails at the first start.
      const enabled = await tx<Array<{ difficulty: string; n: number }>>`
        SELECT difficulty, count(*)::int AS n FROM room_pool WHERE game = ${args.game!} AND enabled GROUP BY difficulty
      `;
      const byDifficulty = Object.fromEntries(enabled.map((e) => [e.difficulty, e.n]));
      for (const [difficulty, needed] of Object.entries(ROOM_PACK_WANTED)) {
        if ((byDifficulty[difficulty] ?? 0) < needed) throw new Error(`Enabled pool needs at least ${needed} ${difficulty} items (has ${byDifficulty[difficulty] ?? 0}); nothing written`);
      }
      return { inserted, updated: rows.length - inserted, enabled: byDifficulty };
    });
    console.log(`Written: ${result.inserted} new, ${result.updated} updated. Enabled per difficulty: ${JSON.stringify(result.enabled)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
