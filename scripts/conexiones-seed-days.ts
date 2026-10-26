/**
 * Seeds the Conexiones futboleras daily boards (conexiones_days). Dry run unless --write.
 *
 *   npx tsx scripts/conexiones-seed-days.ts --file <days.json> --approved <approved.json> --target local|staging|production [--write] [--allow-correction]
 *
 * <days.json> is {days: [{day, number, board: {board}}]}, built by the private pipeline. Every day is parsed with the
 * server's day schema and must be approved by the fact-check exactly as it is. A group too close to one the room pool
 * ever showed (conexiones_ledger) is refused. The merged schedule (stored + incoming) is checked: each board once, a
 * footballer at most once in any 3 days, a link in any 2. Every published group goes into the ledger. A day already seeded
 * with other content is refused unless --allow-correction, which unranks every run of that day; /start then restarts
 * each unfinished run on the new board. Prints counts only, never a group.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { z } from 'zod';
import { dayBoardSchema } from '../src/modules/conexiones/conexiones.rules.js';
import { CONTENT_START, conexionesCalendar } from '../src/modules/conexiones/conexiones.days.js';
import { foldName, refuseOverlap, requireApproved, writeLedger } from '../src/modules/conexiones/conexiones.seed.js';
import { CONEXIONES_CONTENT_LOCK } from '../src/modules/room/games/conexiones/conexiones.rules.js';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';

/** Days between two boards with the same footballer / the same link in the dailies (the private export plans with these). */
const GAP_DAYS = { id: 3, name: 3, link: 2 } as const;

const fileSchema = z.object({
  days: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), number: z.number().int().positive(), board: z.unknown() }).strict()).min(1).max(500),
}).strict();

/** A day's content version: a hash of its board (positive, below 2^32). */
const versionOf = (board: unknown) => (parseInt(createHash('sha256').update(JSON.stringify(board)).digest('hex').slice(0, 8), 16) % 0xfffffffe) + 1;

function parseArgs(argv: string[]) {
  const args: { file?: string; approved?: string; target?: PistasSeedTarget; write: boolean; allowCorrection: boolean } = { write: false, allowCorrection: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]);
    if (arg === '--write') args.write = true;
    else if (arg === '--allow-correction') args.allowCorrection = true;
    else if (arg.startsWith('--file')) args.file = value();
    else if (arg.startsWith('--approved')) args.approved = value();
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
    const parsed = dayBoardSchema.safeParse(d.board);
    if (!parsed.success) throw new Error(`${d.day}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    if (d.day < CONTENT_START || d.day > conexionesCalendar.LAST_DAY) throw new Error(`${d.day} is outside the calendar (${CONTENT_START} → ${conexionesCalendar.LAST_DAY})`);
    if (d.number !== conexionesCalendar.dayNumber(d.day)) throw new Error(`${d.day}: number ${d.number} is not board #${conexionesCalendar.dayNumber(d.day)}`);
    return { day: d.day, number: d.number, board: parsed.data, version: versionOf(parsed.data) };
  });
  if (new Set(days.map((d) => d.day)).size !== days.length) throw new Error('Duplicate day in the file');
  if (new Set(days.map((d) => d.board.board.id)).size !== days.length) throw new Error('A board appears on two days');
  requireApproved(days.map((d) => d.board.board), args.approved);
  console.log(`Conexiones days: ${days.length} (${days[0].day} → ${days.at(-1)!.day}) -> ${target.label}`);
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
      await tx`SELECT pg_advisory_xact_lock(hashtext(${CONEXIONES_CONTENT_LOCK}))`;
      await refuseOverlap(tx, 'daily', days.map((d) => d.board.board));
      // A board shown on one day (even if a correction took it off since) never comes back on another: its groups are known.
      const moved = await tx<Array<{ board_id: string }>>`
        SELECT l.board_id FROM conexiones_ledger l
        JOIN unnest(${tx.array(days.map((d) => d.board.board.id))}::text[], ${tx.array(days.map((d) => d.day))}::date[]) AS n(board_id, day)
          ON n.board_id = l.board_id
        WHERE l.side = 'daily' AND l.day <> n.day LIMIT 1`;
      if (moved.length > 0) throw new Error(`Board ${moved[0].board_id} was already shown on another day; refused`);
      // The whole schedule as it will stand: a footballer or a link at most once in any window of days.
      const incoming = new Set(days.map((d) => d.day));
      const stored = (await tx<Array<{ day: string; board: z.infer<typeof dayBoardSchema> }>>`
        SELECT day::text AS day, board FROM conexiones_days`).filter((r) => !incoming.has(r.day));
      const schedule = [...stored.map((r) => ({ day: r.day, board: r.board.board })), ...days.map((d) => ({ day: d.day, board: d.board.board }))]
        .sort((a, b) => a.day.localeCompare(b.day));
      const lastDay = new Map<string, string>();
      for (const d of schedule) {
        const keys = [...d.board.tiles.flatMap((t) => [`id:${t.player}`, `name:${foldName(t.name.en)}`]), ...d.board.groups.map((g) => `link:${g.key}`)];
        for (const key of keys) {
          const before = lastDay.get(key);
          const gap = GAP_DAYS[key.split(':')[0] as keyof typeof GAP_DAYS];
          if (before && (Date.parse(d.day) - Date.parse(before)) / 86_400_000 < gap) throw new Error(`${key.split(':')[0]} repeats on ${before} and ${d.day} (needs ${gap} days apart)`);
          lastDay.set(key, d.day);
        }
      }
      const existing = new Map((await tx<Array<{ day: string; content_version: string }>>`
        SELECT day::text AS day, content_version FROM conexiones_days WHERE day = ANY(${days.map((d) => d.day)}::date[])`).map((r) => [r.day, Number(r.content_version)]));
      const changed = days.filter((d) => existing.has(d.day) && existing.get(d.day) !== d.version);
      if (changed.length > 0 && !args.allowCorrection) throw new Error(`${changed.length} day(s) already seeded with other content (first ${changed[0].day}); add --allow-correction`);
      let written = 0;
      let unranked = 0;
      for (const d of days) {
        if (existing.get(d.day) === d.version) continue;
        await tx`
          INSERT INTO conexiones_days (day, number, content_version, board) VALUES (${d.day}, ${d.number}, ${d.version}, ${tx.json(d.board as never)})
          ON CONFLICT (day) DO UPDATE SET number = EXCLUDED.number, content_version = EXCLUDED.content_version, board = EXCLUDED.board, updated_at = now()`;
        if (existing.has(d.day)) unranked += (await tx`UPDATE conexiones_runs SET ranked = false WHERE day = ${d.day} AND ranked`).count;
        written += 1;
      }
      await writeLedger(tx, 'daily', days.map((d) => ({ board: d.board.board, day: d.day })));
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
