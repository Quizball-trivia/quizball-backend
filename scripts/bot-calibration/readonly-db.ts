/**
 * Read-only-by-construction DB access for the offline calibration script.
 *
 * Two independent guards so a write is impossible even if one is bypassed:
 *   1. Every query runs inside a `BEGIN TRANSACTION READ ONLY` block — Postgres
 *      itself rejects any data-modifying statement (INSERT/UPDATE/DELETE/DDL).
 *   2. Every SQL string is screened by `assertSelectOnly` before execution;
 *      anything that is not a SELECT/WITH … SELECT throws locally, before it
 *      ever reaches the server.
 *
 * The connection string comes ONLY from CALIBRATION_DATABASE_URL (never
 * DATABASE_URL), so pointing this at prod is a deliberate act. The connection is
 * opened with a hard statement timeout and a tiny pool.
 */

import postgres from 'postgres';

export type ReadOnlyRunner = <T extends readonly Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<T>;

// Whole-word data-modifying keywords. Both boundaries matter: a leading-only
// boundary would flag column names like `deleted_at` / `updated_at` (DELETE /
// UPDATE prefixes). SET requires a following token that is NOT TRANSACTION (so
// `SET TRANSACTION READ ONLY` is fine but `SET x = …` is not).
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|MERGE|CALL|VACUUM|REINDEX|COMMENT|LOCK|NOTIFY)\b|\bDO\b\s*\$|\bREFRESH\s+MATERIALIZED\b|\bSET\s+(?!TRANSACTION\b)\w/i;

/**
 * Throw unless the statement is a pure read (SELECT or WITH … SELECT). Strips
 * SQL comments first so a commented-out keyword doesn't trip the screen and a
 * real one can't hide behind a comment. This is a SECONDARY guard — the primary
 * protection is that every statement runs inside a READ ONLY transaction, which
 * the server enforces regardless of this screen.
 */
export function assertSelectOnly(sqlText: string): void {
  const stripped = sqlText
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  const head = stripped.replace(/^\(*/, '').trimStart().slice(0, 6).toUpperCase();
  const isRead = head.startsWith('SELECT') || head.startsWith('WITH');
  if (!isRead) {
    throw new Error(`Calibration is read-only: refusing non-SELECT statement starting with "${stripped.slice(0, 40)}"`);
  }
  if (FORBIDDEN.test(stripped)) {
    throw new Error('Calibration is read-only: statement contains a data-modifying keyword');
  }
}

export interface ReadOnlyDb {
  /** Tagged-template query, screened + run inside the READ ONLY transaction. */
  query: ReadOnlyRunner;
  end: () => Promise<void>;
}

/**
 * Open a read-only calibration connection. Requires CALIBRATION_DATABASE_URL;
 * refuses to run without it (so it can never silently fall back to the app DB).
 */
export function openReadOnlyDb(options: { statementTimeoutMs?: number } = {}): ReadOnlyDb {
  const dsn = process.env.CALIBRATION_DATABASE_URL;
  if (!dsn) {
    throw new Error(
      'CALIBRATION_DATABASE_URL is required (this script never uses DATABASE_URL). ' +
        'Point it at a read-only pooler connection, e.g. the Supabase transaction pooler.',
    );
  }

  const sql = postgres(dsn, {
    max: 2,
    idle_timeout: 20,
    connection: {
      // Belt-and-suspenders: mark the whole session read-only at the server too.
      default_transaction_read_only: 'on',
      statement_timeout: String(options.statementTimeoutMs ?? 120_000),
    },
  });

  const query: ReadOnlyRunner = async (strings, ...params) => {
    const text = strings.join('?');
    assertSelectOnly(text);
    // Run inside an explicit READ ONLY transaction: a write would error at the
    // server even if the local screen were somehow bypassed.
    return sql.begin('read only', async (tx) => {
      const runner = tx as unknown as typeof sql;
      return runner(strings, ...params);
    }) as unknown as Promise<Parameters<ReadOnlyRunner>[0] extends never ? never : any>;
  };

  return {
    query: query as ReadOnlyRunner,
    end: () => sql.end({ timeout: 5 }),
  };
}
