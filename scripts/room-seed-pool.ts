/**
 * Seeds the private room-game pool (room_pool) for one game. Dry run unless --write.
 *
 *   npx tsx scripts/room-seed-pool.ts --game aproximado --file <pool.json> --target local|staging|production [--write]
 *
 * <pool.json> is {game, items: [{item_id, difficulty, fingerprint, payload, tags?}]}, produced by the game's private
 * generator (~/dev/quizball-private/…), which keeps the pool disjoint from the daily. Every payload is validated
 * against the game's schema. A "played for both" pool belongs to one footballer release, which must already be seeded
 * (scripts/wordgames-seed-release.ts); pairs of any other release are switched off. Prints counts only, never a value.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { z } from 'zod';
import { aproximadoItemSchema, ROOM_GAMES, ROOM_PACK_WANTED, type RoomGameId } from '../src/modules/room/room.types.js';
import { nameChainItemSchema } from '../src/modules/room/games/name-chain/name-chain.room.js';
import { sharedPlayerItemSchema } from '../src/modules/room/games/shared-player/shared-player.engine.js';
import { SHARED_PLAYER_DIFFICULTIES, SHARED_PLAYER_SCOPES } from '../src/modules/room/games/shared-player/shared-player.room.js';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';
import { clubPairKey, WORDGAMES_CONTENT_LOCK } from '../src/modules/wordgame-daily/wordgame-daily.seed.js';

const rowSchema = z.object({
  item_id: z.string().min(1).max(64),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  fingerprint: z.string().min(8).max(64),
  payload: z.record(z.unknown()),
  tags: z.array(z.string().min(1).max(16)).max(8).default([]),
}).strict();
const SEED_BATCH = 300;
const fileSchema = z.object({ game: z.enum(ROOM_GAMES), items: z.array(rowSchema).min(1) }).strict();
/** Games whose pool belongs to one footballer release (seeded first with wordgames-seed-release). */
const RELEASE_GAMES: ReadonlySet<RoomGameId> = new Set(['shared_player', 'name_chain']);
/** A scope must hold this many times a match's pairs of a difficulty, or a group meets the same pairs at once. */
const SCOPE_DEPTH = 2;

interface GameSeed {
  item: z.ZodTypeAny;
  /** What one match deals per difficulty, per tag ('' = the whole pool). */
  needs: Array<{ tag: string; difficulty: string; n: number }>;
}
const GAME_SEEDS: Partial<Record<RoomGameId, GameSeed>> = {
  aproximado: { item: aproximadoItemSchema, needs: Object.entries(ROOM_PACK_WANTED).map(([difficulty, n]) => ({ tag: '', difficulty, n })) },
  shared_player: {
    item: sharedPlayerItemSchema,
    // Every scope offers every difficulty, so each needs enough pairs for more than one match of a single difficulty.
    needs: SHARED_PLAYER_SCOPES.flatMap((tag) => SHARED_PLAYER_DIFFICULTIES.map((difficulty) => ({ tag, difficulty, n: 10 * SCOPE_DEPTH }))),
  },
  // The name chain has no questions: its one item says which release the matches are played on.
  name_chain: { item: nameChainItemSchema, needs: [{ tag: '', difficulty: 'easy', n: 1 }] },
};

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
  const seed = GAME_SEEDS[args.game];
  if (!seed) throw new Error(`${args.game} has no pool to seed`);
  const badPayloads = rows.filter((r) => !seed.item.safeParse(r.payload).success).length;
  if (badPayloads > 0) throw new Error(`${badPayloads} items do not match the ${args.game} item schema`);
  const releases = [...new Set(rows.map((r) => r.payload.release).filter((release): release is string => typeof release === 'string'))];
  const ofRelease = RELEASE_GAMES.has(args.game);
  if (ofRelease && releases.length !== 1) throw new Error(`A ${args.game} pool must be of one release (found ${releases.length})`);
  for (const [field, pick] of [['item_id', (r: typeof rows[number]) => r.item_id], ['fingerprint', (r: typeof rows[number]) => r.fingerprint]] as const) {
    if (new Set(rows.map(pick)).size !== rows.length) throw new Error(`Duplicate ${field} in the pool`);
  }
  if (rows.some((r) => r.payload.id !== r.item_id)) throw new Error('payload.id must equal item_id');
  const counts = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.difficulty]: (acc[r.difficulty] ?? 0) + 1 }), {});
  console.log(`${args.game} room pool: ${rows.length} items ${JSON.stringify(counts)} -> ${target.label}`);
  // A pool short of what a match deals would fail at the first start.
  const inFile = (need: GameSeed['needs'][number]) => rows.filter((r) => r.difficulty === need.difficulty && (!need.tag || r.tags.includes(need.tag))).length;
  for (const need of seed.needs) {
    if (inFile(need) < need.n) throw new Error(`Pool needs at least ${need.n} ${need.difficulty} items${need.tag ? ` tagged ${need.tag}` : ''} (has ${inFile(need)})`);
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
      await tx`SET LOCAL idle_in_transaction_session_timeout = '120s'`;
      if (ofRelease) {
        // The dailies' seed takes the same lock: the daily / room overlap check cannot be raced.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${WORDGAMES_CONTENT_LOCK}))`;
        if (args.game === 'shared_player') {
          // By id and by the two clubs: the same pair under another id would leak just the same.
          const clubs = rows.flatMap((r) => {
            const { a, b } = r.payload as { a?: { key?: unknown }; b?: { key?: unknown } };
            return typeof a?.key === 'string' && typeof b?.key === 'string' ? [clubPairKey(a.key, b.key)] : [];
          });
          const [{ n: inDaily }] = await tx<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM shared_player_days d CROSS JOIN LATERAL jsonb_array_elements(d.pairs->'pairs') AS p(pair)
            WHERE p.pair->>'id' = ANY(${tx.array(rows.map((r) => r.item_id))}::text[])
               OR least(p.pair->'a'->>'key', p.pair->'b'->>'key') || '|' || greatest(p.pair->'a'->>'key', p.pair->'b'->>'key') = ANY(${tx.array(clubs)}::text[])`;
          if (inDaily > 0) throw new Error(`${inDaily} room pair(s) are also daily pairs; refused (a room reveal would hand out a daily answer)`);
        }
        const [release] = await tx<Array<{ id: string }>>`SELECT id FROM wordgame_releases WHERE id = ${releases[0]}`;
        if (!release) throw new Error(`Footballer release ${releases[0]} is not seeded here; run wordgames-seed-release first`);
        // Every accepted footballer must be one the release knows, or a right answer could never be named.
        const accepted = [...new Set(rows.flatMap((r) => (Array.isArray(r.payload.accepted) ? (r.payload.accepted as string[]) : [])))];
        let unknown = 0;
        for (let i = 0; i < accepted.length; i += 5_000) {
          const [{ n }] = await tx<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM unnest(${accepted.slice(i, i + 5_000)}::text[]) AS a(pid)
            WHERE NOT EXISTS (SELECT 1 FROM wordgame_players p WHERE p.release_id = ${releases[0]} AND p.pid = a.pid)`;
          unknown += n;
        }
        if (unknown > 0) throw new Error(`${unknown} accepted footballers are not in release ${releases[0]}; nothing written`);
      }
      // A release that was switched off as a whole (a newer one replaced it) comes back whole when it is seeded again;
      // single items disabled by hand inside a live release stay disabled.
      const [{ retiredBefore }] = ofRelease
        ? await tx<Array<{ retiredBefore: boolean }>>`
            SELECT (count(*) > 0 AND count(*) FILTER (WHERE enabled) = 0) AS "retiredBefore"
            FROM room_pool WHERE game = ${args.game!} AND payload->>'release' = ${releases[0]}`
        : [{ retiredBefore: false }];
      let inserted = 0;
      // A few hundred rows per statement: one round trip each (row by row, 900 round trips through the pooler took
      // long enough for it to drop the connection mid-transaction).
      for (let i = 0; i < rows.length; i += SEED_BATCH) {
        const batch = rows.slice(i, i + SEED_BATCH);
        const written = await tx<Array<{ inserted: boolean }>>`
          INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, tags)
          SELECT ${args.game!}, t.item_id, t.difficulty, t.fingerprint, p.item->'payload', ARRAY(SELECT jsonb_array_elements_text(p.item->'tags'))
          FROM unnest(
            ${batch.map((r) => r.item_id)}::text[], ${batch.map((r) => r.difficulty)}::text[], ${batch.map((r) => r.fingerprint)}::text[]
          ) WITH ORDINALITY AS t(item_id, difficulty, fingerprint, n)
          JOIN jsonb_array_elements(${tx.json(batch.map((r) => ({ payload: r.payload, tags: r.tags })) as never)}) WITH ORDINALITY AS p(item, n) USING (n)
          ON CONFLICT (game, item_id) DO UPDATE SET difficulty = EXCLUDED.difficulty, payload = EXCLUDED.payload,
            fingerprint = EXCLUDED.fingerprint, tags = EXCLUDED.tags, updated_at = now(),
            -- An id that last belonged to another release (switched off with it) is this release's item now; within
            -- one release a row disabled by hand stays disabled.
            enabled = CASE WHEN room_pool.payload->>'release' IS DISTINCT FROM EXCLUDED.payload->>'release' THEN true ELSE room_pool.enabled END
          RETURNING (xmax = 0) AS inserted
        `;
        inserted += written.filter((row) => row.inserted).length;
      }
      if (retiredBefore) await tx`UPDATE room_pool SET enabled = true, updated_at = now() WHERE game = ${args.game!} AND NOT enabled AND payload->>'release' = ${releases[0]}`;
      // Items of an older footballer release are switched off: a match is always dealt from one release.
      const retired = ofRelease
        ? (await tx`UPDATE room_pool SET enabled = false, updated_at = now() WHERE game = ${args.game!} AND enabled AND payload->>'release' IS DISTINCT FROM ${releases[0]}`).count
        : 0;
      // What a match can actually draw from: enabled rows only (a row disabled on purpose stays disabled). Short on
      // any difficulty: roll back rather than leave a pool that fails at the first start.
      const enabled = await tx<Array<{ difficulty: string; tags: string[]; n: number }>>`
        SELECT difficulty, tags, count(*)::int AS n FROM room_pool WHERE game = ${args.game!} AND enabled GROUP BY difficulty, tags
      `;
      const have = (need: GameSeed['needs'][number]) => enabled.filter((e) => e.difficulty === need.difficulty && (!need.tag || e.tags.includes(need.tag))).reduce((sum, e) => sum + e.n, 0);
      for (const need of seed.needs) {
        if (have(need) < need.n) throw new Error(`Enabled pool needs at least ${need.n} ${need.difficulty} items${need.tag ? ` tagged ${need.tag}` : ''} (has ${have(need)}); nothing written`);
      }
      const byDifficulty = enabled.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.difficulty]: (acc[e.difficulty] ?? 0) + e.n }), {});
      return { inserted, updated: rows.length - inserted, enabled: byDifficulty, retired };
    });
    console.log(`Written: ${result.inserted} new, ${result.updated} updated${result.retired ? `, ${result.retired} of an older release switched off` : ''}. Enabled per difficulty: ${JSON.stringify(result.enabled)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
