/**
 * Seeds one word-game footballer release (wordgame_releases + wordgame_players). Dry run unless --write.
 *
 *   npx tsx scripts/wordgames-seed-release.ts --file <release.json> --target local|staging|production [--write]
 *
 * <release.json> is {release: {id, matcherVersion}, players: [{pid, name, game, fame, aliases}]}, produced by the
 * private builder (~/dev/quizball-private/turkish-word-games). A release is immutable: the same id with the same
 * content is a no-op, the same id with different content is refused. Prints counts only, never a name.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { checkRelease } from '../src/modules/footballers/footballers.seed.js';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';

const SEED_BATCH = 2_000;

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
  if (!args.file) throw new Error('--file <release.json> is required');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(args.file), 'utf8'));
  } catch {
    throw new Error(`${args.file}: unreadable or not JSON`);
  }
  const { file, fingerprint } = checkRelease(raw);
  const { id, matcherVersion } = file.release;
  console.log(`word game release ${id}: ${file.players.length} footballers, matcher ${matcherVersion}, fingerprint ${fingerprint} -> ${target.label}`);
  if (!args.write) {
    console.log('Dry run: nothing written (add --write).');
    return;
  }
  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1, prepare: false, connect_timeout: 15, onnotice: () => undefined, ssl: target.kind === 'local' ? false : 'require',
  });
  try {
    const outcome = await sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '120s'`;
      await tx`SET LOCAL idle_in_transaction_session_timeout = '120s'`;
      const [existing] = await tx<Array<{ fingerprint: string }>>`SELECT fingerprint FROM wordgame_releases WHERE id = ${id} FOR UPDATE`;
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error(`Release ${id} already exists with different content; a changed release needs a new id`);
        return 'unchanged' as const;
      }
      await tx`INSERT INTO wordgame_releases (id, fingerprint, matcher_version, players) VALUES (${id}, ${fingerprint}, ${matcherVersion}, ${file.players.length})`;
      for (let i = 0; i < file.players.length; i += SEED_BATCH) {
        const batch = file.players.slice(i, i + SEED_BATCH);
        await tx`
          INSERT INTO wordgame_players (release_id, pid, name, game_name, fame, aliases)
          SELECT ${id}, p->>'pid', p->>'name', p->>'game', (p->>'fame')::int, ARRAY(SELECT jsonb_array_elements_text(p->'aliases'))
          FROM jsonb_array_elements(${tx.json(batch as never)}) AS p
        `;
      }
      const [{ n }] = await tx<Array<{ n: number }>>`SELECT count(*)::int AS n FROM wordgame_players WHERE release_id = ${id}`;
      if (n !== file.players.length) throw new Error(`Wrote ${n} of ${file.players.length} footballers; nothing kept`);
      return 'written' as const;
    });
    console.log(outcome === 'written' ? `Written: release ${id}, ${file.players.length} footballers.` : `Release ${id} is already there with the same content; nothing to do.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
