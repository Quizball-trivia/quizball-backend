/**
 * Shared pieces of the *-locale-from-staging.ts scripts, which copy one locale's content from staging (where it was
 * translated and checked) to PRODUCTION. Both connections must be Supabase pooler URLs whose user names the project:
 * PROD_DATABASE_URL = postgres.lfbwhxvwubzeqkztghok, STAGING_DATABASE_URL = postgres.nsdfiprfmhdqhbfxfwpv.
 * Staging is only ever read, inside read-only transactions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { PROD_REF, STAGING_REF } from './staging-target.js';

export const WRITE = process.argv.includes('--write');
export const opt = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** The locale to copy; there is no default, so a bare run refuses. */
export function requireLocale(supported: readonly string[] = ['pt', 'ru', 'de', 'ka', 'es', 'tr']): string {
  const locale = opt('locale');
  if (!locale || !supported.includes(locale)) {
    console.error(`ABORT: --locale=<${supported.join('|')}> is required`);
    process.exit(1);
  }
  return locale;
}

function poolerUser(name: string, url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`${name} is not set or not a valid URL`); }
  // A query parameter can override the user, host or database the driver connects with: only TLS mode is allowed.
  if ([...u.searchParams.keys()].some((k) => k !== 'sslmode')) throw new Error(`${name} may not carry connection parameters`);
  if (!u.hostname.endsWith('.pooler.supabase.com')) throw new Error(`${name} must use the Supabase pooler host`);
  return decodeURIComponent(u.username);
}

export function connect(): { prod: postgres.Sql; staging: postgres.Sql } {
  const prodUrl = process.env.PROD_DATABASE_URL ?? '';
  const stagingUrl = process.env.STAGING_DATABASE_URL ?? '';
  try {
    if (poolerUser('PROD_DATABASE_URL', prodUrl) !== `postgres.${PROD_REF}`) throw new Error(`PROD_DATABASE_URL must be the production pooler user postgres.${PROD_REF}`);
    if (poolerUser('STAGING_DATABASE_URL', stagingUrl) !== `postgres.${STAGING_REF}` || decodeURIComponent(stagingUrl).includes(PROD_REF)) {
      throw new Error(`STAGING_DATABASE_URL must be the staging pooler user postgres.${STAGING_REF}`);
    }
  } catch (error) {
    console.error(`ABORT: ${(error as Error).message}`);
    process.exit(1);
  }
  const options = { prepare: false, max: 2, ssl: 'require' as const, onnotice: () => {}, connect_timeout: 20, idle_timeout: 20 };
  return { prod: postgres(prodUrl, options), staging: postgres(stagingUrl, options) };
}

export function banner(what: string, locale: string): void {
  console.log(`PRODUCTION ${PROD_REF} ← staging ${STAGING_REF} · ${what} · locale ${locale} · ${WRITE ? 'WRITE' : 'dry run (add --write to write)'}\n`);
}

/** A read in its own short read-only transaction (never a session-level SET on the transaction pooler). */
export function readOnly<T>(sql: postgres.Sql, read: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  // Plain SELECTs, as the ru promotion read: a BEGIN READ ONLY pipelined with its query through the :6543 pooler
  // dropped the connection mid-run (postgres.js pipelining behind Supavisor).
  return read(sql);
}

/**
 * A production write transaction with the release limits: wait 2 s for a lock at most, 15 s per statement (the
 * production role also ends a transaction idle for 15 s, so the work inside must be a few quick statements).
 */
export function writeTx<T>(sql: postgres.Sql, work: (tx: postgres.Sql) => Promise<T>, options: { campaignGuard?: boolean } = {}): Promise<T> {
  return sql.begin(async (transaction) => {
    // The driver's typings drop the call signature of a transaction handle.
    const tx = transaction as unknown as postgres.Sql;
    await tx`SELECT set_config('lock_timeout', '2s', true), set_config('statement_timeout', '15s', true)`;
    // Quiz Page questions refuse writes outside the CMS unless this transaction-local guard is on (as the importers do).
    if (options.campaignGuard) await tx`SELECT set_config('quizball.campaign_quiz_write', 'on', true)`;
    return work(tx);
  }) as Promise<T>;
}

let snapshots = 0;
/** A JSON file under scripts/.snapshots/ (gitignored), written before the write it documents. */
export function snapshot(name: string, data: unknown): string {
  mkdirSync('scripts/.snapshots', { recursive: true });
  const file = `scripts/.snapshots/prod-${name}-${Date.now()}-${(snapshots += 1)}.json`;
  writeFileSync(file, JSON.stringify(data));
  return file;
}

export const pause = (ms = 200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Rows by key; a key that more than one row holds maps to null (ambiguous, never matched). */
export function uniqueBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T | null> {
  const out = new Map<string, T | null>();
  for (const row of rows) {
    const k = key(row);
    out.set(k, out.has(k) ? null : row);
  }
  return out;
}

export const sample = (keys: readonly string[], n = 8): string => (keys.length ? ` (${keys.slice(0, n).join(', ')}${keys.length > n ? ', …' : ''})` : '');
