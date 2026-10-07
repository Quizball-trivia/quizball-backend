/**
 * Seeds the Freecroco dailies' content pool (partner_content_pool) by copying eligible published bank questions per
 * game, minus today's/yesterday's public guest sets when the shared cache is reachable (plays exclude those again at
 * draw time). Idempotent: re-running only adds new questions; it never removes or reactivates a row. Dry run unless
 * --write. Prints counts only, never content.
 *
 *   npx tsx scripts/partner-content-pool-seed.ts --target local [--write] [--games=true-false,countdown] [--per-game=500]
 *
 * --target must match DATABASE_URL: local for a local database, else the exact Supabase project (a staging or
 * production run is a reviewed release step, not part of local development).
 * Later, dedicated partner content: insert it with source = 'dedicated', then
 *   UPDATE partner_content_pool SET active = false WHERE partner_slug = 'freecroco' AND source = 'bank_copy';
 */
import 'dotenv/config';
import postgres from 'postgres';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';
import { seedPartnerContentPool } from '../src/modules/partners/games/dailies/content-pool.js';
import { isPartnerDailyGameId, type PartnerDailyGameId } from '../src/modules/partners/games/dailies/daily-rules.js';
import { parseSeedDatabaseUrl } from '../src/modules/partners/games/dailies/seed-target.js';
import type { Db } from '../src/modules/partners/partner-db.js';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  if (argv[i].includes('=')) return argv[i].slice(argv[i].indexOf('=') + 1);
  const value = argv[i + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

async function main(): Promise<void> {
  const target = arg('target') as PistasSeedTarget | undefined;
  if (target && !SEED_TARGETS.includes(target)) throw new Error('--target local|staging|production');
  // Validated fields first (one host, one user@host, no parameters); the target guard then checks that same host.
  const conn = parseSeedDatabaseUrl(process.env.DATABASE_URL);
  const where = resolvePistasSeedTarget(process.env.DATABASE_URL, target);
  if ((where.kind === 'local') !== conn.local) throw new Error('DATABASE_URL host and --target disagree');
  const games = arg('games')?.split(',').map((g) => g.trim()).filter(Boolean);
  if (games?.some((g) => !isPartnerDailyGameId(g))) throw new Error('--games: countdown, true-false, pick-em, career-path, higher-lower');
  const perGame = arg('per-game') ? Number(arg('per-game')) : undefined;
  if (perGame !== undefined && (!Number.isInteger(perGame) || perGame < 1)) throw new Error('--per-game must be a positive whole number');
  const write = arg('write') === 'true';

  const db = postgres({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    ssl: conn.local ? false : 'require',
    max: 1,
    onnotice: () => undefined,
  });
  try {
    console.log(`${write ? 'Seeding' : 'Dry run against'} ${where.label}`);
    const results = await seedPartnerContentPool(db as unknown as Db, {
      partnerSlug: 'freecroco',
      games: games as PartnerDailyGameId[] | undefined,
      perGameLimit: perGame,
      dryRun: !write,
    });
    console.table(results);
    if (!write) console.log('Nothing written. Add --write to seed.');
  } finally {
    await db.end({ timeout: 5 });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
