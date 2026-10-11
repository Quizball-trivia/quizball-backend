/**
 * Picks the daily grid's board for each day that has none yet. Dry run unless --write.
 *
 *   npx tsx scripts/grid-daily-seed-days.ts --target local|staging|production [--write] [--from YYYY-MM-DD] [--days N]
 *
 * Days already seeded are never changed (a played day keeps its board). Boards come from the live European pool
 * with a difficulty score of at least --min-score (default 0.55, the daily should be playable alone), best-known
 * first, and no board (by content, whatever release it is in) is used for two days. Run the board checker first so
 * the pool has scores. Prints counts only.
 *
 * A closed day's answers are public, so a daily board must never be dealt online. Two things follow:
 * - Run this only once every backend replica runs a release that leaves daily boards out of online play (the one
 *   that added grid_daily_days). A replica on older code would still deal them.
 * - A match may have picked a board in the moment before its day was stored. So a day is first written as
 *   reserved (`board.reserved`, this run's own token): online play already leaves the board alone, the daily
 *   game does not serve it yet. The script then waits for every database transaction that began before that
 *   write to end, drops any reserved day whose board a live match is using (it was never shown, so the board
 *   goes back to online play) and only then publishes the rest. A run that dies in between leaves reserved days;
 *   the next run takes them over and finishes them. Two runs at once cannot publish each other's days: every
 *   change names the token the day was checked under.
 * The wait needs to see every session of the database (a superuser or a member of pg_read_all_stats); with a
 * lesser role the script stops before publishing anything.
 */
import 'dotenv/config';
import { randomInt, randomUUID } from 'node:crypto';
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

/**
 * A day's content version: positive, 32 bits, and new whenever the day gets a board. Random rather than derived
 * from the board, because the version is public and must not let anyone work out which board a day holds.
 */
const contentVersion = (): number => randomInt(1, 2 ** 32);

/** How long to wait for transactions that began before the reservation; they are match starts, seconds long. */
const BARRIER_TIMEOUT_MS = 180_000;
const BARRIER_POLL_MS = 2_000;
const MAX_PASSES = 3;

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
    const token = randomUUID();
    const reserveMissing = (alsoDays: string[] = []) => sql.begin(async (tx) => {
      const taken = await tx<Array<{ day: string; board_id: string; checksum: string | null }>>`
        SELECT day::text AS day, board->>'boardId' AS board_id, board->>'checksum' AS checksum FROM grid_daily_days`;
      const seeded = new Set(taken.map((row) => row.day));
      const missing = [...new Set([...wanted, ...alsoDays])].filter((day) => !seeded.has(day));
      const candidates = await tx<Array<{ id: string; checksum: string }>>`
        SELECT pool.id, pool.checksum
          FROM (
            SELECT DISTINCT ON (b.canonical_checksum)
                   b.id, b.canonical_checksum AS checksum, (d.basis = 'measured') AS measured, b.familiarity_score
              FROM football_grid_boards b
              JOIN football_grid_content_releases r ON r.id = b.release_id AND r.status = 'published'
              JOIN football_grid_board_difficulty d ON d.board_id = b.id
             WHERE b.theme = 'european' AND d.verdict <> 'retire' AND d.score >= ${args.minScore}
               AND NOT (b.id = ANY(${tx.array(taken.map((row) => row.board_id))}::uuid[]))
               AND NOT (b.canonical_checksum = ANY(${tx.array(taken.flatMap((row) => (row.checksum ? [row.checksum] : [])))}::text[]))
               -- A board someone is playing online right now, in any release, is not made public under them.
               AND NOT EXISTS (
                 SELECT 1 FROM football_grid_matches m
                   JOIN football_grid_boards mb ON mb.id = m.board_id
                  WHERE mb.canonical_checksum = b.canonical_checksum AND m.phase <> 'terminal'
               )
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
             ORDER BY b.canonical_checksum, (d.basis = 'measured') DESC, b.familiarity_score DESC, md5(b.id::text)
          ) pool
         ORDER BY pool.measured DESC, pool.familiarity_score DESC, md5(pool.id::text)
         LIMIT ${missing.length}`;
      if (candidates.length < missing.length) {
        throw new Error(`Only ${candidates.length} boards score ${args.minScore} or more for ${missing.length} days; run the board checker with --write, or lower --min-score`);
      }
      if (args.write) {
        for (const [index, day] of missing.entries()) {
          await tx`
            INSERT INTO grid_daily_days (day, number, content_version, board)
            VALUES (${day}, ${dayNumber(day)}, ${contentVersion()}, ${tx.json({ boardId: candidates[index].id, checksum: candidates[index].checksum, reserved: token })})
            ON CONFLICT (day) DO NOTHING`;
        }
      }
      return { fresh: missing.length, kept: wanted.length - missing.length };
    });

    /** Every transaction in this database that began before `since` has ended (match starts among them). */
    const waitForEarlierTransactions = async (since: string): Promise<void> => {
      const [sight] = await sql<Array<{ full: boolean }>>`
        SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS full`;
      if (!sight?.full) throw new Error('This database role cannot see other sessions, so it cannot tell when earlier match starts have ended; nothing was published (the days stay reserved)');
      const deadline = Date.now() + BARRIER_TIMEOUT_MS;
      for (;;) {
        const [row] = await sql<Array<{ open: number }>>`
          SELECT count(*)::int AS open FROM pg_stat_activity
           WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()
             AND xact_start IS NOT NULL AND xact_start < ${since}::timestamptz`;
        if ((row?.open ?? 0) === 0) return;
        if (Date.now() >= deadline) throw new Error('Older database transactions are still open, so the reserved days were not published; run the script again');
        await new Promise((resolve) => setTimeout(resolve, BARRIER_POLL_MS));
      }
    };

    /** Publishes the reserved days no live match stands on; drops the others and says which days they were. */
    const settleReserved = async (): Promise<{ published: number; dropped: string[] }> => {
      // Days another run left reserved become this run's: from here only this token can change them, and the
      // wait below starts after the takeover, so whatever is published was checked under it.
      const reserved = await sql<Array<{ day: string; checksum: string | null }>>`
        UPDATE grid_daily_days SET board = jsonb_set(board, '{reserved}', to_jsonb(${token}::text))
         WHERE jsonb_exists(board, 'reserved')
        RETURNING day::text AS day, board->>'checksum' AS checksum`;
      if (reserved.length === 0) return { published: 0, dropped: [] };
      const [{ since }] = await sql<Array<{ since: string }>>`SELECT clock_timestamp()::text AS since`;
      await waitForEarlierTransactions(since);
      const live = await sql<Array<{ checksum: string }>>`
        SELECT DISTINCT mb.canonical_checksum AS checksum
          FROM football_grid_matches m
          JOIN football_grid_boards mb ON mb.id = m.board_id
         WHERE m.phase <> 'terminal'
           AND mb.canonical_checksum = ANY(${sql.array(reserved.flatMap((row) => (row.checksum ? [row.checksum] : [])))}::text[])`;
      const clashing = reserved.filter((row) => live.some((match) => match.checksum === row.checksum)).map((row) => row.day);
      const clean = reserved.filter((row) => !clashing.includes(row.day)).map((row) => row.day);
      // Only ever a row still reserved under this run's token: a published day is never taken back, and a day
      // another run has taken over is left to it.
      const dropped = await sql<Array<{ day: string }>>`
        DELETE FROM grid_daily_days WHERE day = ANY(${sql.array(clashing)}::date[]) AND board->>'reserved' = ${token} RETURNING day::text AS day`;
      const published = await sql`
        UPDATE grid_daily_days SET board = board - 'reserved'
         WHERE day = ANY(${sql.array(clean)}::date[]) AND board->>'reserved' = ${token} RETURNING day`;
      return { published: published.length, dropped: dropped.map((row) => row.day) };
    };

    const first = await reserveMissing();
    let published = 0;
    let replaced = 0;
    for (let pass = 1; args.write; pass += 1) {
      const settled = await settleReserved();
      published += settled.published;
      if (settled.dropped.length === 0) break;
      if (pass >= MAX_PASSES) throw new Error(`${settled.dropped.length} days are still without a board because live matches kept using the ones picked; run the script again`);
      replaced += settled.dropped.length;
      // A dropped day may lie outside this run's range (taken over from an earlier run): it still gets a board.
      await reserveMissing(settled.dropped);
    }
    console.log(`Daily grid days ${wanted[0]} to ${wanted[wanted.length - 1]} -> ${target.label}`);
    console.log(`${args.write ? `Written: ${published} published` : `Dry run (add --write): ${first.fresh} to add`}, ${first.kept} already there and left as they are.`);
    if (replaced > 0) console.log(`${replaced} picks were replaced because a live match was using that board.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
