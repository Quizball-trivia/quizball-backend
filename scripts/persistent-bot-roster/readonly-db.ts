/**
 * Read-only-by-construction DB access for the roster measurement script.
 *
 * Adopts the calibration script's pattern (fix/calibration-ops, now on staging),
 * hardened per PR5 review finding #9: Supabase's transaction-mode pooler does
 * NOT forward startup parameters, and role-level GUCs override them — so a
 * startup `default_transaction_read_only=on` is unreliable. Instead, EVERY query
 * runs inside an explicit `BEGIN TRANSACTION READ ONLY` and, on every query, the
 * wrapper asserts `SHOW transaction_read_only = 'on'` so the run fails loudly if
 * the connection is not actually read-only. A per-query
 * `SET LOCAL statement_timeout` is applied (role GUCs can pin a low default).
 *
 * The DSN comes ONLY from ROSTER_MEASURE_DATABASE_URL (never DATABASE_URL), so
 * pointing this at staging/prod is a deliberate act; point it at a genuinely
 * read-only DB role. A secondary local screen refuses any non-SELECT text before
 * it reaches the server. Reimplemented locally rather than imported because the
 * calibration script keys off CALIBRATION_DATABASE_URL, a different env var.
 */

import postgres from 'postgres';

// Whole-word data-modifying keywords (secondary screen; the READ ONLY
// transaction is the primary guarantee). Both word boundaries matter so column
// names like `deleted_at`/`updated_at` don't trip it; SET must be followed by a
// token other than TRANSACTION/LOCAL so timeout SET LOCALs are allowed.
const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|MERGE|CALL|VACUUM|REINDEX|COMMENT|LOCK|NOTIFY)\b|\bDO\b\s*\$|\bREFRESH\s+MATERIALIZED\b|\bSET\s+(?!TRANSACTION\b|LOCAL\b)\w/i;

export function assertSelectOnly(sqlText: string): void {
  const stripped = sqlText
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  const head = stripped.replace(/^\(*/, '').trimStart().slice(0, 6).toUpperCase();
  if (!(head.startsWith('SELECT') || head.startsWith('WITH'))) {
    throw new Error(`Roster measurement is read-only: refusing non-SELECT starting with "${stripped.slice(0, 40)}"`);
  }
  if (FORBIDDEN.test(stripped)) {
    throw new Error('Roster measurement is read-only: statement contains a data-modifying keyword');
  }
}

/** Runs one screened SELECT inside a READ ONLY transaction on a fresh connection. */
export type ReadOnlyQuery = <T extends Record<string, unknown>[]>(sqlText: string) => Promise<T>;

export interface ReadOnlyDb {
  query: ReadOnlyQuery;
}

export function openReadOnlyDb(options: { statementTimeoutMs?: number } = {}): ReadOnlyDb {
  const dsn = process.env.ROSTER_MEASURE_DATABASE_URL;
  if (!dsn) {
    throw new Error(
      'ROSTER_MEASURE_DATABASE_URL is required (this script never uses DATABASE_URL). ' +
        'Point it at a READ-ONLY DB role on the pooler.',
    );
  }
  const statementTimeout = Math.max(0, Math.round(options.statementTimeoutMs ?? 60_000));

  const query: ReadOnlyQuery = async <T extends Record<string, unknown>[]>(sqlText: string) => {
    assertSelectOnly(sqlText);
    // Fresh connection per query: a single long-lived pooled connection was
    // observed to wedge against the Supabase pooler after several queries.
    const sql = postgres(dsn, {
      max: 1,
      // The pooler cache-invalidates prepared statements; the app uses the same
      // setting for the same Supavisor topology.
      prepare: false,
      onnotice: () => {},
    });
    try {
      return (await sql.begin('read only', async (tx) => {
        // Role GUCs can override startup params, so pin the timeout locally.
        await tx.unsafe(`SET LOCAL statement_timeout = ${statementTimeout}`);
        // Fail loudly if the connection is not actually read-only (e.g. a
        // read-write role was supplied by mistake).
        const [ro] = await tx.unsafe<{ transaction_read_only: string }[]>('SHOW transaction_read_only');
        if (ro?.transaction_read_only !== 'on') {
          throw new Error(
            `Roster measurement refuses to run: transaction_read_only='${ro?.transaction_read_only}'. ` +
              'Point ROSTER_MEASURE_DATABASE_URL at a read-only DB role.',
          );
        }
        return tx.unsafe<T>(sqlText);
      })) as unknown as T;
    } finally {
      await sql.end({ timeout: 5 });
    }
  };

  return { query };
}
