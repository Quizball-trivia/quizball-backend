#!/usr/bin/env npx tsx
/**
 * Legacy fake-account cleanup (PR11).
 *
 * Hard-deletes the synthetic `is_seed = true` populations and drains aged
 * ephemeral AI users. DRY-RUN IS THE DEFAULT: without --execute the script only
 * counts and prints, and performs zero writes.
 *
 * The seed flag covers three DIFFERENT populations (see predicate.ts), so a
 * scope must always be named explicitly — there is deliberately no "all":
 *
 *   npm run seed:cleanup -- --scope legacy                       # dry-run
 *   npm run seed:cleanup -- --scope loadtest --execute --allow-remote
 *   npm run seed:cleanup -- --drain-ephemeral
 *
 * Remote targets additionally require BURNIN_CONFIRM_ENV to match the target's
 * Supabase project ref (shared target guard, post-incident).
 */
import { config as loadEnv } from 'dotenv';

// `.env.local` ONLY, and never a bare loadEnv(): loading `.env` here is what
// pointed a cleanup DELETE at staging during the 2026-07-28 incident.
loadEnv({ path: '.env.local' });

import postgres from 'postgres';

import { assertDbTarget, resolveTarget } from '../bot-burnin/target-guard.js';
import type { SqlLike } from '../persistent-bot-roster/db-types.js';
import { census, deleteScope, drainEphemeral, BLOCKING_FKS } from './engine.js';
import { SCOPES, type Scope } from './predicate.js';

/**
 * Must equal cleanup_ai_users()'s `recent_window`, which in turn must equal the
 * recent-matches API limit max in src/modules/stats/stats.schemas.ts. If the
 * endpoint can return N matches, cleanup must protect N.
 */
const RECENT_WINDOW = 10;
const DEFAULT_BATCH_SIZE = 1000;
/**
 * Ceiling on --batch-size. Batching exists to keep each transaction's lock
 * footprint and duration small; an arbitrarily large batch would take the
 * entire population in one transaction and defeat the point.
 */
const MAX_BATCH_SIZE = 10_000;

const BOOLEAN_FLAGS = ['--execute', '--allow-remote', '--drain-ephemeral'] as const;
const VALUE_FLAGS = ['--scope', '--batch-size', '--max-batches'] as const;
const KNOWN_FLAGS: readonly string[] = [...BOOLEAN_FLAGS, ...VALUE_FLAGS];

function knownFlagList(): string {
  return `Valid flags:\n  ${[...KNOWN_FLAGS].sort().join('\n  ')}`;
}

/**
 * Reject anything argv-shaped we do not recognise BEFORE any DB work (#346).
 * A silently-ignored typo on a destructive script means the operator believes
 * they scoped/limited a run that in fact used defaults.
 */
export function validateArgv(argv: string[]): void {
  const errors: string[] = [];
  const valueFlags = new Set<string>(VALUE_FLAGS);
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue; // a value consumed by its flag

    if (token.includes('=')) {
      const [name] = token.split('=', 1);
      errors.push(
        KNOWN_FLAGS.includes(name)
          ? `${name} must be passed as '${name} <value>', not '${token}'.`
          : `Unknown flag: ${token}`,
      );
      continue;
    }
    if (!KNOWN_FLAGS.includes(token)) {
      errors.push(`Unknown flag: ${token}`);
      continue;
    }
    if (seen.has(token)) errors.push(`Flag passed more than once: ${token}`);
    seen.add(token);

    if (valueFlags.has(token)) {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) {
        errors.push(`${token} requires a value.`);
      } else {
        i++; // consume the value so it is never mistaken for a flag
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid arguments:\n  ${errors.join('\n  ')}\n\n${knownFlagList()}`);
  }
}

export interface Args {
  scope: Scope | null;
  execute: boolean;
  allowRemote: boolean;
  drainEphemeral: boolean;
  batchSize: number;
  maxBatches: number | null;
}

export function parseArgs(argv: string[]): Args {
  validateArgv(argv);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const has = (flag: string) => argv.includes(flag);

  const int = (v: string | undefined, flag: string, min: number, max: number): number | undefined => {
    if (v == null) return undefined;
    const n = Number(v);
    // Must ERROR rather than fall back to a default: a typo'd batch size
    // silently reverting to 1000 is exactly the class of surprise this guards.
    // The upper bound matters too — an unbounded batch size defeats batching
    // entirely and takes the whole population in one long-locking transaction.
    if (v.trim() === '' || !Number.isSafeInteger(n) || n < min || n > max) {
      throw new Error(`Malformed value for ${flag}: '${v}' — expected an integer between ${min} and ${max}.`);
    }
    return n;
  };

  const rawScope = get('--scope');
  if (rawScope != null && !SCOPES.includes(rawScope as Scope)) {
    throw new Error(`Unknown --scope '${rawScope}'. Valid scopes: ${SCOPES.join(', ')}.`);
  }
  const scope = (rawScope as Scope | undefined) ?? null;
  const drain = has('--drain-ephemeral');

  if (scope == null && !drain) {
    throw new Error(
      `Nothing to do: pass --scope <${SCOPES.join('|')}> and/or --drain-ephemeral.\n` +
        `There is deliberately no "all" scope — the is_seed flag covers distinct populations.`,
    );
  }

  return {
    scope,
    execute: has('--execute'),
    allowRemote: has('--allow-remote'),
    drainEphemeral: drain,
    batchSize: int(get('--batch-size'), '--batch-size', 1, MAX_BATCH_SIZE) ?? DEFAULT_BATCH_SIZE,
    maxBatches: int(get('--max-batches'), '--max-batches', 1, 1_000_000) ?? null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is not set (expected in .env.local).');
  assertDbTarget(dsn, { allowRemote: args.allowRemote });
  const target = resolveTarget(dsn);

  // NOTE on enforcing dry-run in the DB: neither a read-only transaction nor a
  // read-only session can be used, because Postgres forbids temp-table DDL in
  // both and the protected-match set is a temp table. Dry-run safety is
  // therefore structural: census() issues only SELECTs against user data, its
  // DDL is confined to pg_temp, and the write path (deleteScope /
  // drainEphemeral) is simply never reached unless --execute was passed.
  const sql = postgres(dsn, { max: 2, idle_timeout: 20 }) as unknown as SqlLike;
  try {
    console.log(`target        : ${target.host} (${target.confirmToken})`);
    console.log(`mode          : ${args.execute ? 'EXECUTE (writes)' : 'DRY-RUN (no writes)'}`);
    console.log(`recent window : ${RECENT_WINDOW} matches protected per human`);
    console.log(`blocking FKs  : ${BLOCKING_FKS.join(', ')} (all other user FKs CASCADE/SET NULL)`);
    console.log('');

    if (args.scope) {
      const before = await census(sql, args.scope, RECENT_WINDOW);
      console.log(`scope '${args.scope}':`);
      console.log(`  is_seed rows in scope : ${before.total}`);
      console.log(`  deletable now         : ${before.deletable}`);
      console.log(`  withheld by guards    : ${before.withheld}`);
      console.log(`  winner_user_id to NULL: ${before.winnerRefs}`);
      console.log(`  lobbies to delete     : ${before.lobbyRefs}`);

      if (args.execute) {
        console.log('');
        const total = await deleteScope(
          sql,
          args.scope,
          { batchSize: args.batchSize, recentWindow: RECENT_WINDOW, maxBatches: args.maxBatches ?? undefined },
          (p) => console.log(`  batch ${p.batch}: deleted ${p.deleted} (total ${p.runningTotal})`),
        );
        const after = await census(sql, args.scope, RECENT_WINDOW);
        console.log(`  DELETED ${total}; remaining in scope: ${after.total} (deletable ${after.deletable})`);
      } else {
        console.log('  (dry-run — pass --execute to delete)');
      }
      console.log('');
    }

    if (args.drainEphemeral) {
      console.log('ephemeral drain (cleanup_ai_users):');
      if (args.execute) {
        const drained = await drainEphemeral(sql);
        console.log(`  drained ${drained} AI users`);
      } else {
        const [row] = await sql.unsafe<{ aged: string }[]>(`
          SELECT count(*) AS aged FROM public.users
          WHERE is_ai = true AND created_at < NOW() - INTERVAL '7 days'
        `);
        console.log(`  ${Number(row?.aged ?? 0)} AI users are past the 7-day age gate`);
        console.log('  (dry-run — the function applies its own visibility/friend/mid-match guards)');
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run when invoked directly, so tests can import the parser.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
