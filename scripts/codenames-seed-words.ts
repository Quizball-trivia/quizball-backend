/**
 * Seeds one language's Football Codenames word deck into the room pool (room_pool, game codenames, tag word-<lang>).
 * Dry run unless --write.
 *
 *   npx tsx scripts/codenames-seed-words.ts --file <deck.json> --target local|staging|production [--write]
 *
 * <deck.json> is a private deck (~/dev/quizball-private/codenames/words/<lang>.json):
 * {lang, words: [{w, football, other, clues}]}. Every word is validated with the server's item schema. The file is the
 * whole deck of its language: words of that language missing from it are switched off; picture cards are never
 * touched. Prints counts only, never a word.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { z } from 'zod';
import { ROOM_LOCALES } from '../src/modules/room/room.types.js';
import { boardMatcher, clueProblem, clueTerm, codenamesWordItemSchema, WORDS_BOARD, wordItemId, wordTag } from '../src/modules/room/games/codenames/codenames.rules.js';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';

const deckSchema = z.object({
  lang: z.enum(ROOM_LOCALES),
  words: z.array(z.object({ w: z.string(), football: z.string(), other: z.string(), clues: z.array(z.string()) }).passthrough()).min(WORDS_BOARD.size),
}).passthrough();
const SEED_BATCH = 300;

function parseArgs(argv: string[]) {
  const args: { file?: string; target?: PistasSeedTarget; write: boolean } = { write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]);
    if (arg === '--write') args.write = true;
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
  if (!args.file) throw new Error('--file <deck.json> is required');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(args.file), 'utf8'));
  } catch {
    throw new Error(`${args.file}: unreadable or not JSON`);
  }
  const deck = deckSchema.safeParse(raw);
  if (!deck.success) throw new Error(`Invalid deck: ${deck.error.issues.slice(0, 5).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  const { lang } = deck.data;
  const items = deck.data.words.map((w) => codenamesWordItemSchema.safeParse({
    id: wordItemId(lang, w.w), lang, word: w.w, football: w.football, other: w.other, clues: w.clues,
  }));
  const bad = items.filter((i) => !i.success).length;
  if (bad > 0) throw new Error(`${bad} words do not match the word item schema`);
  const rows = items.map((i) => {
    const payload = (i as { data: z.infer<typeof codenamesWordItemSchema> }).data;
    return { item_id: payload.id, fingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32), payload };
  });
  if (new Set(rows.map((r) => r.item_id)).size !== rows.length) throw new Error('Two words of the deck fold to the same spelling');
  // A bot clue must be one a Scout could type (length, word count, blocklist).
  const unsayable = rows.reduce((n, r) => n + r.payload.clues.filter((clue) => clueProblem(clue, new Set()) !== null).length, 0);
  if (unsayable > 0) throw new Error(`${unsayable} clues break the clue rules (too long, too many words or blocked)`);
  // A clue that is, holds or is part of any deck word could meet that word on a board: refused here, not at play.
  const allWords = rows.map((r) => r.payload.word);
  const onDeck = boardMatcher(allWords);
  const overlapping = rows.reduce((n, r) => n + r.payload.clues.filter((clue) => onDeck(clue) !== null).length, 0);
  if (overlapping > 0) throw new Error(`${overlapping} clues overlap a deck word`);
  // Each clue must fit at least two words, or it can never link cards.
  // Counted by the bot's term identity (case, accents and spacing folded), as dealing will link them.
  const links = new Map<string, number>();
  for (const r of rows) for (const id of new Set(r.payload.clues.map((clue) => clueTerm(clue).id))) links.set(id, (links.get(id) ?? 0) + 1);
  const lonely = [...links.values()].filter((n) => n < 2).length;
  if (lonely > 0) throw new Error(`${lonely} clues fit only one word`);
  const tag = wordTag(lang);
  console.log(`codenames ${tag}: ${rows.length} words -> ${target.label}`);
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
      // One seed per language at a time: the retirement below reads what the upsert wrote.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`codenames_words:${lang}`}))`;
      let inserted = 0;
      for (let i = 0; i < rows.length; i += SEED_BATCH) {
        const batch = rows.slice(i, i + SEED_BATCH);
        const written = await tx<Array<{ inserted: boolean }>>`
          INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, tags)
          SELECT 'codenames', t.item_id, 'easy', t.fingerprint, p.payload, ARRAY[${tag}]::text[]
          FROM unnest(${batch.map((r) => r.item_id)}::text[], ${batch.map((r) => r.fingerprint)}::text[]) WITH ORDINALITY AS t(item_id, fingerprint, n)
          JOIN jsonb_array_elements(${tx.json(batch.map((r) => r.payload) as never)}) WITH ORDINALITY AS p(payload, n) USING (n)
          ON CONFLICT (game, item_id) DO UPDATE SET payload = EXCLUDED.payload, fingerprint = EXCLUDED.fingerprint, tags = EXCLUDED.tags,
            enabled = true, updated_at = now()
          RETURNING (xmax = 0) AS inserted
        `;
        inserted += written.filter((row) => row.inserted).length;
      }
      // The file is the whole deck of its language.
      const retired = (await tx`
        UPDATE room_pool SET enabled = false, updated_at = now()
        WHERE game = 'codenames' AND enabled AND tags @> ARRAY[${tag}]::text[] AND NOT (item_id = ANY(${rows.map((r) => r.item_id)}::text[]))
      `).count;
      const [{ n }] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM room_pool WHERE game = 'codenames' AND enabled AND tags @> ARRAY[${tag}]::text[]
      `;
      if (n < WORDS_BOARD.size) throw new Error(`Only ${n} enabled words for ${tag}; nothing written`);
      return { inserted, updated: rows.length - inserted, retired, enabled: n };
    });
    console.log(`Written: ${result.inserted} new, ${result.updated} updated, ${result.retired} switched off. Enabled ${tag}: ${result.enabled}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
