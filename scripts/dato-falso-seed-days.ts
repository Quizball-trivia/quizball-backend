/**
 * Seeds the Dato falso futbolero daily cards (dato_falso_days). Dry run unless --write.
 *
 *   npx tsx scripts/dato-falso-seed-days.ts --file <days.json> --target local|staging|production [--write] [--allow-correction]
 *
 * <days.json> is {days: [{day, number, cards: {cards: [10 cards]}}]}, built by the private pipeline. Every day is parsed
 * with the server's day schema. A footballer the room pool ever showed (dato_falso_ledger) is refused: a room reveal
 * would help with a daily. The merged schedule (stored + incoming) is checked: each card once, each footballer at most
 * once a week. Every published card goes into the ledger. A day already seeded with other content is refused unless --allow-correction,
 * which unranks every run of that day; /start then restarts each unfinished run on the new cards. Prints counts only,
 * never a fake.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { z } from 'zod';
import { dayCardsSchema } from '../src/modules/dato-falso/dato-falso.rules.js';
import { CONTENT_START, datoFalsoCalendar } from '../src/modules/dato-falso/dato-falso.days.js';
import { DATO_FALSO_CONTENT_LOCK, DF_PLAYER_GAP_DAYS, dfPlayerKeys } from '../src/modules/room/games/dato-falso/dato-falso.rules.js';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';

const fileSchema = z.object({
  days: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), number: z.number().int().positive(), cards: z.unknown() }).strict()).min(1).max(500),
}).strict();

/** A day's content version: a hash of its cards (positive, below 2^32). */
const versionOf = (cards: unknown) => (parseInt(createHash('sha256').update(JSON.stringify(cards)).digest('hex').slice(0, 8), 16) % 0xfffffffe) + 1;

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
    const cards = dayCardsSchema.safeParse(d.cards);
    if (!cards.success) throw new Error(`${d.day}: ${cards.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    if (d.day < CONTENT_START || d.day > datoFalsoCalendar.LAST_DAY) throw new Error(`${d.day} is outside the calendar (${CONTENT_START} → ${datoFalsoCalendar.LAST_DAY})`);
    if (d.number !== datoFalsoCalendar.dayNumber(d.day)) throw new Error(`${d.day}: number ${d.number} is not set #${datoFalsoCalendar.dayNumber(d.day)}`);
    return { day: d.day, number: d.number, cards: cards.data, version: versionOf(cards.data) };
  });
  if (new Set(days.map((d) => d.day)).size !== days.length) throw new Error('Duplicate day in the file');
  const ids = days.flatMap((d) => d.cards.cards.map((c) => c.id));
  if (new Set(ids).size !== ids.length) throw new Error('A card appears on two days');
  console.log(`Dato falso days: ${days.length} (${days[0].day} → ${days.at(-1)!.day}) -> ${target.label}`);
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
      await tx`SELECT pg_advisory_xact_lock(hashtext(${DATO_FALSO_CONTENT_LOCK}))`;
      // A footballer is on one side only, by id and by name, against everything the rooms ever showed.
      const keys = days.flatMap((d) => d.cards.cards.map(dfPlayerKeys));
      const playerIds = keys.map((k) => k.id);
      const playerNames = keys.map((k) => k.name);
      const [{ n: inRooms }] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM dato_falso_ledger
        WHERE side = 'room' AND (player_id = ANY(${tx.array(playerIds)}::text[]) OR player_name = ANY(${tx.array(playerNames)}::text[]))`;
      if (inRooms > 0) throw new Error(`${inRooms} room card(s) are about footballers of these days; refused (a room reveal would help with a daily)`);
      // A card shown on one day (even if a correction took it off since) never comes back on another: its fake is known.
      const moved = await tx<Array<{ card_id: string }>>`
        SELECT l.card_id FROM dato_falso_ledger l
        JOIN unnest(${tx.array(days.flatMap((d) => d.cards.cards.map((c) => c.id)))}::text[], ${tx.array(days.flatMap((d) => d.cards.cards.map(() => d.day)))}::date[]) AS n(card_id, day)
          ON n.card_id = l.card_id
        WHERE l.side = 'daily' AND l.day <> n.day LIMIT 1`;
      if (moved.length > 0) throw new Error(`Card ${moved[0].card_id} was already shown on another day; refused`);
      // The whole schedule as it will stand: a card once, a footballer at most once in any window of days.
      const incoming = new Set(days.map((d) => d.day));
      const stored = (await tx<Array<{ day: string; cards: { cards: Array<{ id: string; player: { id: string; name: { en: string } } }> } }>>`
        SELECT day::text AS day, cards FROM dato_falso_days`).filter((r) => !incoming.has(r.day));
      const schedule = [...stored.map((r) => ({ day: r.day, cards: r.cards.cards })), ...days.map((d) => ({ day: d.day, cards: d.cards.cards }))]
        .sort((a, b) => a.day.localeCompare(b.day));
      const seenCards = new Set<string>();
      const lastDay = new Map<string, string>();
      for (const d of schedule) {
        for (const c of d.cards) {
          if (seenCards.has(c.id)) throw new Error(`Card ${c.id} is on two days (second ${d.day})`);
          seenCards.add(c.id);
          // By id and by name: one person can come from two sources under two ids.
          const k = dfPlayerKeys(c as Parameters<typeof dfPlayerKeys>[0]);
          for (const key of [`id:${k.id}`, `name:${k.name}`]) {
            const before = lastDay.get(key);
            if (before && (Date.parse(d.day) - Date.parse(before)) / 86_400_000 < DF_PLAYER_GAP_DAYS) throw new Error(`A footballer is on ${before} and ${d.day} (needs ${DF_PLAYER_GAP_DAYS} days apart)`);
            lastDay.set(key, d.day);
          }
        }
      }
      const existing = new Map((await tx<Array<{ day: string; content_version: string }>>`
        SELECT day::text AS day, content_version FROM dato_falso_days WHERE day = ANY(${days.map((d) => d.day)}::date[])`).map((r) => [r.day, Number(r.content_version)]));
      const changed = days.filter((d) => existing.has(d.day) && existing.get(d.day) !== d.version);
      if (changed.length > 0 && !args.allowCorrection) throw new Error(`${changed.length} day(s) already seeded with other content (first ${changed[0].day}); add --allow-correction`);
      let written = 0;
      let unranked = 0;
      for (const d of days) {
        if (existing.get(d.day) === d.version) continue;
        await tx`
          INSERT INTO dato_falso_days (day, number, content_version, cards) VALUES (${d.day}, ${d.number}, ${d.version}, ${tx.json(d.cards as never)})
          ON CONFLICT (day) DO UPDATE SET number = EXCLUDED.number, content_version = EXCLUDED.content_version, cards = EXCLUDED.cards, updated_at = now()`;
        if (existing.has(d.day)) unranked += (await tx`UPDATE dato_falso_runs SET ranked = false WHERE day = ${d.day} AND ranked`).count;
        written += 1;
      }
      const cards = days.flatMap((d) => d.cards.cards.map((c) => ({ id: c.id, day: d.day })));
      await tx`
        INSERT INTO dato_falso_ledger (side, card_id, player_id, player_name, day)
        SELECT 'daily', * FROM unnest(${tx.array(cards.map((c) => c.id))}::text[], ${tx.array(playerIds)}::text[], ${tx.array(playerNames)}::text[], ${tx.array(cards.map((c) => c.day))}::date[])
        ON CONFLICT DO NOTHING`;
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
