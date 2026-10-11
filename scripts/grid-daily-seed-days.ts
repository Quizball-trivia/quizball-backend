/**
 * Picks the daily grid's board for each day that has none yet. Dry run unless --write.
 *
 *   npx tsx scripts/grid-daily-seed-days.ts --target local|staging|production [--write] [--from YYYY-MM-DD] [--days N]
 *
 * Days already seeded are never changed (a played day keeps its board). Boards come from the live European pool
 * with a difficulty score of at least --min-score (default 0.55, the daily should be playable alone), best-known
 * first, and no board is used for two days. Run the board checker first so the pool has scores. Prints counts only.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';
import { addDays, CONTENT_START, dayNumber, LAST_DAY } from '../src/modules/grid-daily/grid-daily.days.js';

interface Args { target?: PistasSeedTarget; write: boolean; from: string; days: number; minScore: number }

function parseArgs(argv: string[]): Args {
  const args: Args = { write: false, from: CONTENT_START, days: 30, minScore: 0.55 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]);
    if (arg === '--write') args.write = true;
    else if (arg.startsWith('--from')) args.from = value();
    else if (arg.startsWith('--days')) args.days = Number(value());
    else if (arg.startsWith('--min-score')) args.minScore = Number(value());
    else if (arg.startsWith('--target')) {
      const target = value();
      if (!SEED_TARGETS.includes(target as PistasSeedTarget)) throw new Error('--target must be local, staging or production');
      args.target = target as PistasSeedTarget;
    } else throw new Error(`Unknown argument ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.from) || args.from < CONTENT_START) throw new Error(`--from must be a date on or after ${CONTENT_START}`);
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > 366) throw new Error('--days must be 1 to 366');
  if (!(args.minScore > 0 && args.minScore < 1)) throw new Error('--min-score must be between 0 and 1');
  return args;
}

/** A positive 32-bit hash of the day's content, like every daily game's content version. */
function contentVersion(boardId: string): number {
  return createHash('sha256').update(`grid-daily:${boardId}`).digest().readUInt32BE(0) || 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolvePistasSeedTarget(process.env.DATABASE_URL, args.target);
  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1, prepare: false, connect_timeout: 15, onnotice: () => undefined, ssl: target.kind === 'local' ? false : 'require',
  });
  try {
    const wanted: string[] = [];
    for (let i = 0; i < args.days; i += 1) {
      const day = addDays(args.from, i);
      if (day > LAST_DAY) break;
      wanted.push(day);
    }
    const outcome = await sql.begin(async (tx) => {
      const taken = await tx<Array<{ day: string; board_id: string; checksum: string | null }>>`
        SELECT day::text AS day, board->>'boardId' AS board_id, board->>'checksum' AS checksum FROM grid_daily_days`;
      const seeded = new Set(taken.map((row) => row.day));
      const missing = wanted.filter((day) => !seeded.has(day));
      const candidates = await tx<Array<{ id: string; checksum: string }>>`
        SELECT b.id, b.canonical_checksum AS checksum
          FROM football_grid_boards b
          JOIN football_grid_content_releases r ON r.id = b.release_id AND r.status = 'published'
          JOIN football_grid_board_difficulty d ON d.board_id = b.id
         WHERE b.theme = 'european' AND d.verdict <> 'retire' AND d.score >= ${args.minScore}
           AND NOT (b.id = ANY(${tx.array(taken.map((row) => row.board_id))}::uuid[]))
           AND NOT (b.canonical_checksum = ANY(${tx.array(taken.flatMap((row) => (row.checksum ? [row.checksum] : [])))}::text[]))
           -- A board someone is playing online right now is not made public under them.
           AND NOT EXISTS (SELECT 1 FROM football_grid_matches m WHERE m.board_id = b.id AND m.phase <> 'terminal')
           AND NOT EXISTS (
             SELECT 1 FROM football_grid_content_quarantines q
              WHERE q.release_id = b.release_id AND (q.board_id IS NULL OR q.board_id = b.id) AND q.action = 'disable'
                AND (q.expires_at IS NULL OR q.expires_at > now())
                AND NOT EXISTS (
                  SELECT 1 FROM football_grid_content_quarantines newer
                   WHERE newer.release_id = q.release_id AND newer.board_id IS NOT DISTINCT FROM q.board_id
                     AND newer.action = 'enable' AND (newer.created_at, newer.id) > (q.created_at, q.id)
                )
           )
         ORDER BY (d.basis = 'measured') DESC, b.familiarity_score DESC, md5(b.id::text)
         LIMIT ${missing.length}`;
      if (candidates.length < missing.length) {
        throw new Error(`Only ${candidates.length} boards score ${args.minScore} or more for ${missing.length} days; run the board checker with --write, or lower --min-score`);
      }
      if (args.write) {
        for (const [index, day] of missing.entries()) {
          await tx`
            INSERT INTO grid_daily_days (day, number, content_version, board)
            VALUES (${day}, ${dayNumber(day)}, ${contentVersion(candidates[index].id)}, ${tx.json({ boardId: candidates[index].id, checksum: candidates[index].checksum })})
            ON CONFLICT (day) DO NOTHING`;
        }
      }
      return { wanted: wanted.length, fresh: missing.length, kept: wanted.length - missing.length };
    });
    console.log(`Daily grid days ${wanted[0]} to ${wanted[wanted.length - 1]} -> ${target.label}`);
    console.log(`${args.write ? 'Written' : 'Dry run (add --write)'}: ${outcome.fresh} new, ${outcome.kept} already seeded and left as they are.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
