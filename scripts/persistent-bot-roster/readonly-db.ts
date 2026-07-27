/**
 * Read-only-by-construction DB access for the roster measurement script.
 *
 * The measurement pass only ever reads production/staging data; it must be
 * structurally incapable of a write:
 *   - The DSN comes ONLY from ROSTER_MEASURE_DATABASE_URL (never DATABASE_URL),
 *     so pointing this at staging/prod is a deliberate act.
 *   - Every connection is opened with default_transaction_read_only=on, so the
 *     server itself rejects any INSERT/UPDATE/DELETE/DDL.
 *
 * Connection strategy: a FRESH short-lived connection per query
 * (open → unsafe → end). A single long-lived pooled connection was observed to
 * intermittently wedge against the Supabase connection pooler after a handful of
 * sequential queries; a clean connection per query is bulletproof and, for a
 * one-shot measurement pass of ~15 queries, negligibly slower.
 *
 * This mirrors the read-only pattern established by the bot-calibration script
 * (PR4); it is reimplemented locally rather than imported because PR4 is not yet
 * merged into staging.
 */

import postgres from 'postgres';

/** Runs one read-only query on a fresh connection and closes it. */
export type ReadOnlyQuery = <T extends Record<string, unknown>[]>(sqlText: string) => Promise<T>;

export interface ReadOnlyDb {
  /** Run one SELECT (plain string; no dynamic input) on a fresh connection. */
  query: ReadOnlyQuery;
}

export function openReadOnlyDb(options: { statementTimeoutMs?: number } = {}): ReadOnlyDb {
  const dsn = process.env.ROSTER_MEASURE_DATABASE_URL;
  if (!dsn) {
    throw new Error(
      'ROSTER_MEASURE_DATABASE_URL is required (this script never uses DATABASE_URL). ' +
        'Point it at a read-only pooler connection, e.g. the Supabase transaction pooler.',
    );
  }
  const statementTimeout = String(options.statementTimeoutMs ?? 60_000);

  const query: ReadOnlyQuery = async <T extends Record<string, unknown>[]>(sqlText: string) => {
    const sql = postgres(dsn, {
      max: 1,
      prepare: false,
      // Suppress harmless server NOTICEs (e.g. Supabase collation-version
      // mismatch emitted by parallel workers on large scans).
      onnotice: () => {},
      connection: {
        // Server-enforced read-only: a write errors regardless of anything else.
        default_transaction_read_only: 'on',
        statement_timeout: statementTimeout,
      } as unknown as postgres.Options<Record<string, never>>['connection'],
    });
    try {
      return (await sql.unsafe<T>(sqlText)) as unknown as T;
    } finally {
      await sql.end({ timeout: 5 });
    }
  };

  return { query };
}
