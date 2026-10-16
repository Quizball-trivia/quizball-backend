/**
 * Publishes a Football Horserace data release: its tournaments (football_race_releases / _tournaments) and the room pool
 * items that point at them. Dry run unless --write.
 *
 *   npx tsx scripts/football-race-seed-release.ts --dir <releases dir> --release <id> --target local|staging|production [--write]
 *
 * <dir> holds <release>.index.json and one <release>.<TOURNAMENT>.json per tournament, built by the private pipeline
 * (~/dev/quizball-private/football-race/). Every file is parsed with the server's own schema and must match the
 * index's checksum. A release is immutable: a tournament already published with other bytes is refused (publish a new
 * release instead). Publishing switches the room pool to this release; older releases stay readable for the matches
 * and days that use them. Prints counts only, never a value.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { z } from 'zod';
import { dealRace, raceTournamentDataSchema } from '../src/modules/room/games/football-race/football-race.rules.js';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';

/** Shared with the days seed: a day can never reference a release mid-publish. */
export const FOOTBALL_RACE_CONTENT_LOCK = 'football_race_content';

const indexSchema = z.object({
  release: z.string().regex(/^[0-9a-z][0-9a-z.-]{2,59}$/),
  cutoff: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tournaments: z.array(z.object({ tournament: z.string().regex(/^[A-Z0-9]{2,20}$/), file: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).passthrough()).min(1).max(30),
}).strict();

function parseArgs(argv: string[]) {
  const args: { dir?: string; release?: string; target?: PistasSeedTarget; write: boolean } = { write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]);
    if (arg === '--write') args.write = true;
    else if (arg.startsWith('--dir')) args.dir = value();
    else if (arg.startsWith('--release')) args.release = value();
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
  // The host guard runs before any file is read or any connection is opened.
  const target = resolvePistasSeedTarget(process.env.DATABASE_URL, args.target);
  if (!args.dir || !args.release) throw new Error('--dir and --release are required');
  const dir = resolve(args.dir);
  const index = indexSchema.parse(JSON.parse(readFileSync(join(dir, `${args.release}.index.json`), 'utf8')));
  if (index.release !== args.release) throw new Error(`Index is for ${index.release}, not ${args.release}`);
  const files = index.tournaments.map((t) => {
    const bytes = readFileSync(join(dir, t.file));
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== t.sha256) throw new Error(`${t.file}: checksum does not match the index`);
    const parsed = raceTournamentDataSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!parsed.success) throw new Error(`${t.file}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const data = parsed.data;
    if (data.release !== args.release || data.tournament.id !== t.tournament) throw new Error(`${t.file} holds ${data.release}/${data.tournament.id}`);
    return { tournament: t.tournament, sha, data };
  });
  if (new Set(files.map((f) => f.tournament)).size !== files.length) throw new Error('Duplicate tournament in the index');
  // A tournament the room cannot seat a fair 1v1 in would fail its first start.
  const seatable = files.filter((f) => [1, 2, 3, 4, 5].some((seed) => dealRace(f.data, 2, seed)?.fair));
  if (seatable.length === 0) throw new Error('No tournament seats a fair 1v1; nothing to publish');
  console.log(`Football Horserace release ${args.release} (cutoff ${index.cutoff}): ${files.length} tournaments, ${files.reduce((n, f) => n + f.data.stats.length, 0)} stats -> ${target.label}`);
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
      await tx`INSERT INTO football_race_releases (release, cutoff) VALUES (${args.release!}, ${index.cutoff}) ON CONFLICT (release) DO NOTHING`;
      let written = 0;
      for (const f of files) {
        const [existing] = await tx<Array<{ checksum: string }>>`SELECT checksum FROM football_race_tournaments WHERE release = ${args.release!} AND tournament = ${f.tournament}`;
        if (existing && existing.checksum !== f.sha) throw new Error(`${args.release}/${f.tournament} is already published with other data; publish a new release`);
        if (existing) continue;
        await tx`INSERT INTO football_race_tournaments (release, tournament, payload, checksum) VALUES (${args.release!}, ${f.tournament}, ${tx.json(f.data as never)}, ${f.sha})`;
        written += 1;
      }
      // The room pool deals from this release only; older releases stay readable for what already uses them.
      const pool = seatable.map((f) => ({ id: `fr-${args.release}-${f.tournament}`, tournament: f.tournament, fingerprint: f.sha.slice(0, 32) }));
      for (const p of pool) {
        await tx`
          INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, tags)
          VALUES ('football_race', ${p.id}, 'easy', ${p.fingerprint}, ${tx.json({ id: p.id, release: args.release!, tournament: p.tournament })}, ${[p.tournament]})
          ON CONFLICT (game, item_id) DO UPDATE SET enabled = true, updated_at = now()`;
      }
      const retired = (await tx`UPDATE room_pool SET enabled = false, updated_at = now() WHERE game = 'football_race' AND enabled AND payload->>'release' IS DISTINCT FROM ${args.release!}`).count;
      await tx`UPDATE football_race_releases SET enabled = (release = ${args.release!})`;
      return { written, pool: pool.length, retired };
    });
    console.log(`Written: ${result.written} tournament(s) new; room pool ${result.pool} item(s) enabled${result.retired ? `, ${result.retired} of an older release switched off` : ''}.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
