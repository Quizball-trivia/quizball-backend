/**
 * Seeds the Football Codenames daily boards (codenames_days). Dry run unless --write.
 *
 *   npx tsx scripts/codenames-seed-days.ts --file <days.json> --target local|staging|production [--write] [--allow-correction]
 *
 * <days.json> is {days: [{day, number, board}]}, built by the private pipeline (tools/build_days.py). Every board is
 * parsed with the server's day schema, and every card must be one of the card pool (room_pool, game codenames, seeded
 * first with room-seed-pool.ts): its picture ships with the web build. A day already seeded with other content is
 * refused unless --allow-correction, which unranks every run of that day (finished ones too: their score was for other
 * content); /start then restarts each unfinished run on the new board. Prints counts only, never a key or a clue.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { z } from 'zod';
import { dayBoardSchema } from '../src/modules/codenames/codenames.types.js';
import { CONTENT_START, LAST_DAY } from '../src/modules/codenames/codenames.days.js';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';

const CODENAMES_CONTENT_LOCK = 'codenames_content';
const fileSchema = z.object({
  days: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), number: z.number().int().positive(), board: z.unknown() }).strict()).min(1).max(500),
}).strict();

/** A day's content version: a hash of its board (positive, below 2^32). */
const versionOf = (board: unknown) => (parseInt(createHash('sha256').update(JSON.stringify(board)).digest('hex').slice(0, 8), 16) % 0xfffffffe) + 1;

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
    const board = dayBoardSchema.safeParse(d.board);
    if (!board.success) throw new Error(`${d.day}: ${board.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    if (d.day < CONTENT_START || d.day > LAST_DAY) throw new Error(`${d.day} is outside the calendar (${CONTENT_START} → ${LAST_DAY})`);
    return { day: d.day, number: d.number, board: board.data, version: versionOf(board.data) };
  });
  if (new Set(days.map((d) => d.day)).size !== days.length) throw new Error('Duplicate day in the file');
  console.log(`Football Codenames days: ${days.length} (${days[0].day} → ${days.at(-1)!.day}) -> ${target.label}`);
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
      await tx`SELECT pg_advisory_xact_lock(hashtext(${CODENAMES_CONTENT_LOCK}))`;
      const cards = [...new Set(days.flatMap((d) => d.board.cards.map((c) => c.id)))];
      const [{ n: missing }] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM unnest(${tx.array(cards)}::text[]) AS c(id)
        WHERE NOT EXISTS (SELECT 1 FROM room_pool p WHERE p.game = 'codenames' AND p.item_id = c.id)`;
      if (missing > 0) throw new Error(`${missing} card(s) of these boards are not in the card pool; seed the pool first`);
      const existing = new Map((await tx<Array<{ day: string; content_version: string }>>`
        SELECT day::text AS day, content_version FROM codenames_days WHERE day = ANY(${days.map((d) => d.day)}::date[])`).map((r) => [r.day, Number(r.content_version)]));
      const changed = days.filter((d) => existing.has(d.day) && existing.get(d.day) !== d.version);
      if (changed.length > 0 && !args.allowCorrection) throw new Error(`${changed.length} day(s) already seeded with other content (first ${changed[0].day}); add --allow-correction`);
      let written = 0;
      let unranked = 0;
      for (const d of days) {
        if (existing.get(d.day) === d.version) continue;
        await tx`
          INSERT INTO codenames_days (day, number, content_version, board) VALUES (${d.day}, ${d.number}, ${d.version}, ${tx.json(d.board as never)})
          ON CONFLICT (day) DO UPDATE SET number = EXCLUDED.number, content_version = EXCLUDED.content_version, board = EXCLUDED.board, updated_at = now()`;
        if (existing.has(d.day)) unranked += (await tx`UPDATE codenames_runs SET ranked = false WHERE day = ${d.day} AND ranked`).count;
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
