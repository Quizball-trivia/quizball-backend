/**
 * Loads one show pack (the hand-written questions for a host-run show night)
 * into wl_show_packs. Packs live in the private content store, never in this
 * public repo; the orchestrator picks the stored pack up on its next tick and
 * swaps it into that Monday's event, as long as the host has not pressed Start.
 *
 *   npx tsx scripts/wl-show-pack-load.ts --file <pack.json> [--dry-run] [--target staging|production]
 *
 * The pack is validated first (schema, answer ids, a Monday, a known show).
 * A non-local DATABASE_URL is refused unless --target names its Supabase
 * project. Answer keys and rejected values are never printed. The write holds
 * the event's row lock, the same lock the host's Start takes, so it either
 * lands before Start (and Start waits for the swap) or fails loudly after it.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { resolveSeedTarget, PROJECT_REFS, type SeedTargetName } from '../src/modules/buscaminas/buscaminas.seed.js';
import { redactedIssues, showPackHash, showPackLayout, showPackSchema } from '../src/modules/weekend-league/show-packs/show-pack.js';

/** Same lock as lockShowNight() in show-packs/index.ts (kept here so the script never loads the app's DB pool). */
const SHOW_NIGHT_LOCK = (sql: postgres.Sql, slug: string, eventDate: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtext('wl_show_pack'), hashtext(${`${slug}:${eventDate}`}))`;

function parseArgs(argv: string[]): { file: string; dryRun: boolean; target: SeedTargetName | undefined } {
  let file: string | undefined;
  let dryRun = false;
  let target: SeedTargetName | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--file' || arg.startsWith('--file=')) file = arg === '--file' ? argv[++i] : arg.slice(7);
    else if (arg === '--target' || arg.startsWith('--target=')) {
      const value = arg === '--target' ? argv[++i] : arg.slice(9);
      if (!value || !(value in PROJECT_REFS)) throw new Error('--target must be staging or production');
      target = value as SeedTargetName;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!file) throw new Error('--file <pack.json> is required');
  return { file, dryRun, target };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const text = readFileSync(args.file, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message quotes the file around the error, which may be answer text.
    throw new Error('The file is not valid JSON (details withheld: they can quote answers)');
  }
  const parsed = showPackSchema.safeParse(raw);
  if (!parsed.success) {
    for (const line of redactedIssues(parsed.error.issues)) console.error(`  ${line}`);
    throw new Error('Pack is invalid; nothing loaded');
  }
  const pack = parsed.data;
  const hash = showPackHash(pack);
  const layout = showPackLayout(pack).map((r) => `${r.kind}×${r.count}`).join(', ');
  const total = pack.rounds.reduce((n, r) => n + r.questions.length, 0);
  console.log(`[show-pack] ${pack.slug} ${pack.eventDate}: ${total} questions (${layout}), hash ${hash}`);

  const target = resolveSeedTarget(process.env.DATABASE_URL, args.target);
  console.log(`[show-pack] database: ${target.label}`);
  if (args.dryRun) {
    console.log('[show-pack] dry run: nothing written');
    return;
  }

  // An sslmode in the URL (e.g. verify-full with a CA) is the operator's choice and wins; otherwise the repo's
  // seed-script default for Supabase.
  const urlSslMode = new URL(process.env.DATABASE_URL!).searchParams.get('sslmode');
  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1, prepare: false, connect_timeout: 15, onnotice: () => undefined,
    ...(urlSslMode ? {} : { ssl: target.kind === 'local' ? false : 'require' as const }),
  });
  try {
    const event = await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      // Held to commit: the host's Start takes the same lock first, so it sees this pack or this load sees its Start.
      await SHOW_NIGHT_LOCK(txSql, pack.slug, pack.eventDate);
      const [row] = await txSql<{ status: string; started: boolean; hash: string | null }[]>`
        SELECT status, qualifier_starts_at IS NOT NULL AS started, config->>'show_pack_hash' AS hash
        FROM wl_tournaments
        WHERE is_test = true AND config->>'event_slug' = ${pack.slug} AND config->>'event_date' = ${pack.eventDate}
        FOR UPDATE
      `;
      if (row?.started) {
        throw new Error(`The ${pack.eventDate} event has already started (status ${row.status}); its questions can no longer change`);
      }
      if (row && ['completed', 'cancelled', 'voided'].includes(row.status)) {
        throw new Error(`The ${pack.eventDate} event is ${row.status}; a pack can no longer be loaded into it`);
      }
      await txSql`
        INSERT INTO wl_show_packs (slug, event_date, pack)
        VALUES (${pack.slug}, ${pack.eventDate}::date, ${sql.json(pack as never)})
        ON CONFLICT (slug, event_date) DO UPDATE SET pack = EXCLUDED.pack, updated_at = NOW()
      `;
      return row ?? null;
    });
    console.log(event
      ? `[show-pack] stored; event is ${event.status} with pack ${event.hash ?? 'none'} — the orchestrator swaps in ${hash} on its next tick`
      : '[show-pack] stored; no event row for that Monday yet — the orchestrator loads it when it creates the event');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(`[show-pack] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
