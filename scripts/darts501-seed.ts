/**
 * Seeds Football Darts 501 content. Dry run unless --write.
 *
 *   npx tsx scripts/darts501-seed.ts --coverage <pids.txt> --coverage-id <id> --target local|staging|production [--write]
 *   npx tsx scripts/darts501-seed.ts --days <days.json> --target … [--write] [--allow-correction]
 *   npx tsx scripts/darts501-seed.ts --pool <pool.json> --target … [--write]
 *
 * Coverage: the footballers a source holds complete numbers for (one pid per line), written once per id; a set is only
 * ever added to. Days: {days: [{day, number, category}]}; pool: {items: [{item_id, difficulty, category}]}, built by the
 * private pipeline (~/dev/quizball-private/darts501). Every category is parsed with the server's schema and checked
 * against its release and coverage (every entry exists and is covered). A topic the other side (days vs room pool) ever
 * showed (by family: club and competition), a category sharing footballer-and-number pairs with one, or a daily topic
 * already shown on another date, is refused (darts501_ledger, under one advisory lock).
 * A day already seeded with other content is refused unless --allow-correction, which unranks every run of that day.
 * Prints counts only, never a footballer or a number.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { z } from 'zod';
import { categoryProblems, d501CategorySchema, finishWithin, FINISH_DARTS, unreachableEntries, type D501Category } from '../src/modules/darts501/darts501.content.js';
import { CONTENT_START, darts501Calendar } from '../src/modules/darts501-daily/darts501-daily.days.js';
import { tenableDirectories } from '../src/modules/tenable/tenable.directories.js';
import { conflict, keysOf, sharedFinish, type Item, type LedgerRow } from '../src/modules/darts501/darts501.seed.js';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';
import { sql as appSql } from '../src/db/index.js';

export const DARTS501_CONTENT_LOCK = 'darts501-content';
const BATCH = 2_000;

const daysSchema = z.object({ days: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), number: z.number().int().positive(), category: z.unknown() }).strict()).min(1).max(500) }).strict();
const poolSchema = z.object({ items: z.array(z.object({ item_id: z.string().min(1).max(64), difficulty: z.enum(['easy', 'medium', 'hard']), category: z.unknown() }).strict()).min(1).max(2_000) }).strict();

const versionOf = (value: unknown) => (parseInt(createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8), 16) % 0xfffffffe) + 1;

function parseArgs(argv: string[]) {
  const args: { coverage?: string; coverageId?: string; days?: string; pool?: string; target?: PistasSeedTarget; write: boolean; allowCorrection: boolean } = { write: false, allowCorrection: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]);
    if (arg === '--write') args.write = true;
    else if (arg === '--allow-correction') args.allowCorrection = true;
    else if (arg.startsWith('--coverage-id')) args.coverageId = value();
    else if (arg.startsWith('--coverage')) args.coverage = value();
    else if (arg.startsWith('--days')) args.days = value();
    else if (arg.startsWith('--pool')) args.pool = value();
    else if (arg.startsWith('--target')) {
      const target = value();
      if (!SEED_TARGETS.includes(target as PistasSeedTarget)) throw new Error('--target must be local, staging or production');
      args.target = target as PistasSeedTarget;
    } else throw new Error(`Unknown argument ${arg}`);
  }
  if ([args.coverage, args.days, args.pool].filter(Boolean).length !== 1) throw new Error('Give exactly one of --coverage, --days, --pool');
  return args;
}

function parseCategory(raw: unknown, where: string): D501Category {
  const parsed = d501CategorySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${where}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** Every entry exists in the release and is covered; unreachable ones are counted (they simply never score). */
async function checkAgainstRelease(sql: postgres.Sql, categories: D501Category[]): Promise<void> {
  for (const c of categories) {
    const directory = await tenableDirectories.get('player', c.release);
    const covered = new Set((await sql<Array<{ pid: string }>>`SELECT pid FROM darts501_coverage WHERE coverage_id = ${c.coverage} AND pid = ANY(${c.entries.map((e) => e.eid)}::text[])`).map((r) => r.pid));
    if (covered.size === 0) throw new Error(`${c.id}: coverage ${c.coverage} is not seeded here`);
    const problems = categoryProblems(c, directory, covered);
    if (problems.length > 0) throw new Error(`${c.id}: ${problems.length} problem(s), first: ${problems[0]}`);
    const unreachable = new Set(unreachableEntries(c, directory));
    if (!finishWithin(c, FINISH_DARTS, (eid) => !unreachable.has(eid))) throw new Error(`${c.id}: no ${FINISH_DARTS} different throwable footballers check out from 501`);
    console.log(`  ${c.id}: ${c.entries.length} entries, ${unreachable.size} unreachable`);
  }
}

/** Refuses anything that would give answers away (see `conflict`), against the ledger and within the batch; then records every revision. */
async function refuseOverlapAndRecord(tx: postgres.TransactionSql, side: 'daily' | 'room', items: Item[]): Promise<void> {
  const shown = await tx<LedgerRow[]>`SELECT side, category_id, topic_key, entry_keys, day::text AS day FROM darts501_ledger`;
  const incoming: LedgerRow[] = items.map((it) => ({ side, category_id: it.category.id, topic_key: it.category.topicKey, entry_keys: keysOf(it.category), day: it.day }));
  items.forEach((item, i) => {
    const rows = [...shown, ...incoming.filter((_, j) => j !== i)];
    for (const row of rows) {
      const why = conflict(side, item, row);
      if (why) throw new Error(`${item.category.id}: ${why}`);
    }
    const leak = sharedFinish(side, item, rows);
    if (leak) throw new Error(`${item.category.id}: ${leak}`);
  });
  for (const { category, day } of items) {
    await tx`
      INSERT INTO darts501_ledger (side, category_id, revision, topic_key, title_en, entry_keys, day)
      VALUES (${side}, ${category.id}, ${String(versionOf(category))}, ${category.topicKey}, ${category.title.en}, ${keysOf(category)}::text[], ${day})
      ON CONFLICT (side, category_id, revision) DO NOTHING`;
  }
}

/** Thrown at the end of a dry run's transaction: every check ran, nothing is kept. */
class DryRun extends Error {}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolvePistasSeedTarget(process.env.DATABASE_URL, args.target);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, connect_timeout: 15, onnotice: () => undefined, ssl: target.kind === 'local' ? false : 'require' });
  // The same checks in a dry run as in a write, under the same lock; only the commit differs.
  const publish = async <T>(timeout: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T | null> => {
    try {
      return await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = '${timeout}'`);
        await tx`SELECT pg_advisory_xact_lock(hashtext(${DARTS501_CONTENT_LOCK}))`;
        const result = await work(tx);
        if (!args.write) throw new DryRun();
        return result;
      }) as T;
    } catch (error) {
      if (!(error instanceof DryRun)) throw error;
      console.log('Dry run: every check passed; nothing written (add --write).');
      return null;
    }
  };
  try {
    if (args.coverage) {
      if (!args.coverageId || !/^[a-z0-9-]{1,40}$/.test(args.coverageId)) throw new Error('--coverage-id <id> (a-z, 0-9, -) is required');
      const pids = [...new Set(readFileSync(resolve(args.coverage), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))];
      console.log(`Coverage ${args.coverageId}: ${pids.length} footballers -> ${target.label}`);
      const added = await publish('300s', async (tx) => {
        // A coverage set decides which answers are free: once written it never changes (a new source is a new id).
        const [{ n }] = await tx<Array<{ n: number }>>`SELECT count(*)::int AS n FROM darts501_coverage WHERE coverage_id = ${args.coverageId!}`;
        if (n > 0) {
          const [{ same }] = await tx<Array<{ same: number }>>`SELECT count(*)::int AS same FROM darts501_coverage WHERE coverage_id = ${args.coverageId!} AND pid = ANY(${pids}::text[])`;
          if (n !== pids.length || same !== n) throw new Error(`Coverage ${args.coverageId} already exists with other footballers; use a new id`);
          return 0;
        }
        let count = 0;
        for (let i = 0; i < pids.length; i += BATCH) {
          count += (await tx`INSERT INTO darts501_coverage (coverage_id, pid) SELECT ${args.coverageId!}, unnest(${pids.slice(i, i + BATCH)}::text[]) ON CONFLICT DO NOTHING`).count;
        }
        return count;
      });
      if (added !== null) console.log(`Written: ${added} new footballer(s).`);
      return;
    }

    if (args.days) {
      const file = daysSchema.parse(JSON.parse(readFileSync(resolve(args.days), 'utf8')));
      const days = file.days.map((d) => {
        const category = parseCategory(d.category, d.day);
        if (d.day < CONTENT_START || d.day > darts501Calendar.LAST_DAY) throw new Error(`${d.day} is outside the calendar (${CONTENT_START} → ${darts501Calendar.LAST_DAY})`);
        if (d.number !== darts501Calendar.dayNumber(d.day)) throw new Error(`${d.day}: number ${d.number} is not day #${darts501Calendar.dayNumber(d.day)}`);
        return { day: d.day, number: d.number, category, version: versionOf(category) };
      });
      if (new Set(days.map((d) => d.day)).size !== days.length) throw new Error('Duplicate day in the file');
      console.log(`Darts 501 days: ${days.length} (${days[0].day} → ${days.at(-1)!.day}) -> ${target.label}`);
      await checkAgainstRelease(sql, days.map((d) => d.category));
      const result = await publish('120s', async (tx) => {
        await refuseOverlapAndRecord(tx, 'daily', days.map((d) => ({ category: d.category, day: d.day })));
        const existing = new Map((await tx<Array<{ day: string; content_version: string }>>`
          SELECT day::text AS day, content_version FROM darts501_days WHERE day = ANY(${days.map((d) => d.day)}::date[])`).map((r) => [r.day, Number(r.content_version)]));
        const changed = days.filter((d) => existing.has(d.day) && existing.get(d.day) !== d.version);
        if (changed.length > 0 && !args.allowCorrection) throw new Error(`${changed.length} day(s) already seeded with other content (first ${changed[0].day}); add --allow-correction`);
        let written = 0;
        let unranked = 0;
        for (const d of days) {
          if (existing.get(d.day) === d.version) continue;
          await tx`
            INSERT INTO darts501_days (day, number, content_version, category) VALUES (${d.day}, ${d.number}, ${d.version}, ${tx.json(d.category as never)})
            ON CONFLICT (day) DO UPDATE SET number = EXCLUDED.number, content_version = EXCLUDED.content_version, category = EXCLUDED.category, updated_at = now()`;
          if (existing.has(d.day)) unranked += (await tx`UPDATE darts501_runs SET ranked = false WHERE day = ${d.day} AND ranked`).count;
          written += 1;
        }
        return { written, corrected: changed.length, unranked };
      });
      if (result) console.log(`Written: ${result.written} day(s)${result.corrected ? `, ${result.corrected} corrected (${result.unranked} ranked run(s) unranked)` : ''}.`);
      return;
    }

    const file = poolSchema.parse(JSON.parse(readFileSync(resolve(args.pool!), 'utf8')));
    const items = file.items.map((it) => {
      const category = parseCategory(it.category, it.item_id);
      if (category.tier !== it.difficulty) throw new Error(`${it.item_id}: difficulty ${it.difficulty} ≠ tier ${category.tier}`);
      return { ...it, category };
    });
    if (new Set(items.map((it) => it.item_id)).size !== items.length) throw new Error('Duplicate item_id in the file');
    for (const tier of ['easy', 'medium', 'hard'] as const) if (!items.some((it) => it.difficulty === tier)) throw new Error(`The pool has no ${tier} category: no match could be dealt`);
    console.log(`Darts 501 room pool: ${items.length} categories -> ${target.label}`);
    await checkAgainstRelease(sql, items.map((it) => it.category));
    const written = await publish('120s', async (tx) => {
      await refuseOverlapAndRecord(tx, 'room', items.map((it) => ({ category: it.category, day: null })));
      let n = 0;
      for (const it of items) {
        n += (await tx`
          INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, enabled)
          VALUES ('darts501', ${it.item_id}, ${it.difficulty}, ${String(versionOf(it.category))}, ${tx.json(it.category as never)}, true)
          ON CONFLICT (game, item_id) DO UPDATE SET difficulty = EXCLUDED.difficulty, fingerprint = EXCLUDED.fingerprint, payload = EXCLUDED.payload, enabled = true`).count;
      }
      // The pool as it will stand must still deal a match: one enabled category of every tier.
      const tiers = new Set((await tx<Array<{ difficulty: string }>>`SELECT DISTINCT difficulty FROM room_pool WHERE game = 'darts501' AND enabled`).map((r) => r.difficulty));
      const missing = ['easy', 'medium', 'hard'].filter((t) => !tiers.has(t));
      if (missing.length > 0) throw new Error(`The pool would have no ${missing.join('/')} category: no match could be dealt`);
      return n;
    });
    if (written !== null) console.log(`Written: ${written} categor${written === 1 ? 'y' : 'ies'}.`);
  } finally {
    await sql.end({ timeout: 5 });
    await appSql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
