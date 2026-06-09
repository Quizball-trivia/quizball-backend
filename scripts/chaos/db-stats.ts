// Captures DB pressure around a chaos run using pg_stat_statements + live
// pg_stat_activity. Connects directly to the target Postgres (session pooler)
// with a tiny dedicated pool so it doesn't perturb the app's own pool.

import postgres from 'postgres';

export interface StatStatement {
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
}

export interface ActivitySnapshot {
  total: number;
  active: number;
  idle: number;
  idleInTxn: number;
  waitingOnLock: number;
  longestActiveSec: number;
}

export function makeStatsClient(databaseUrl: string) {
  // Dedicated, tiny, short-lived connection — separate from the app pool.
  const sql = postgres(databaseUrl, {
    max: 2,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
  });
  return sql;
}

export async function hasPgStatStatements(
  sql: ReturnType<typeof makeStatsClient>
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
    ) AS exists`;
  return rows[0]?.exists ?? false;
}

export async function resetStatStatements(
  sql: ReturnType<typeof makeStatsClient>
): Promise<void> {
  await sql`SELECT pg_stat_statements_reset()`;
}

export async function topStatements(
  sql: ReturnType<typeof makeStatsClient>,
  limit: number
): Promise<StatStatement[]> {
  // Column names differ across PG versions (total_time vs total_exec_time).
  // Supabase runs PG15+, which uses *_exec_time.
  const rows = await sql<StatStatement[]>`
    SELECT
      query,
      calls,
      round(total_exec_time::numeric, 1) AS "totalMs",
      round(mean_exec_time::numeric, 2) AS "meanMs",
      rows
    FROM pg_stat_statements
    WHERE query NOT ILIKE '%pg_stat_statements%'
      AND query NOT ILIKE '%pg_stat_activity%'
    ORDER BY total_exec_time DESC
    LIMIT ${limit}`;
  return rows;
}

export async function snapshotActivity(
  sql: ReturnType<typeof makeStatsClient>
): Promise<ActivitySnapshot> {
  const rows = await sql<
    {
      total: number;
      active: number;
      idle: number;
      idle_in_txn: number;
      waiting_on_lock: number;
      longest_active_sec: number;
    }[]
  >`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE state = 'active')::int AS active,
      count(*) FILTER (WHERE state = 'idle')::int AS idle,
      count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_txn,
      count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS waiting_on_lock,
      COALESCE(round(max(extract(epoch FROM (now() - query_start)))
        FILTER (WHERE state = 'active'
          AND query NOT ILIKE '%pg_stat_activity%')::numeric, 1), 0)::float8
        AS longest_active_sec
    FROM pg_stat_activity`;
  const r = rows[0];
  return {
    total: r.total,
    active: r.active,
    idle: r.idle,
    idleInTxn: r.idle_in_txn,
    waitingOnLock: r.waiting_on_lock,
    longestActiveSec: r.longest_active_sec,
  };
}

// Replace `$N` placeholders with best-effort literals so pg_stat_statements'
// normalized (parameterized) queries can still be EXPLAIN-ed. This is heuristic:
// most placeholders here are booleans, small ints, or text filters, and the
// plan shape (Seq Scan vs Index Scan) is what we care about, not exact rows.
function substitutePlaceholders(query: string): string {
  // `is_active = $1` / `= $2` boolean-ish → true; pagination ints → modest
  // values; everything else → a neutral text literal. We can't know types, so
  // wrap unknowns as text and rely on Postgres implicit coercion; on failure
  // the caller catches and skips.
  return query.replace(/\$(\d+)/g, (_m, n) => {
    const idx = Number(n);
    // LIMIT/OFFSET placeholders tend to be the last few; give them ints.
    return `'__p${idx}__'`;
  });
}

// EXPLAIN a candidate query (plan only, no ANALYZE → no execution side effects)
// and report whether it does a Seq Scan — the missing-index smell.
export async function explainQuery(
  sql: ReturnType<typeof makeStatsClient>,
  query: string
): Promise<{ plan: string; hasSeqScan: boolean } | null> {
  if (!/^\s*(select|with)/i.test(query)) return null;
  // Skip clearly unsafe / non-idempotent shapes.
  if (/\b(insert|update|delete|nextval|pg_stat_statements_reset)\b/i.test(query)) return null;

  const candidates = /\$\d/.test(query)
    ? [substitutePlaceholders(query)]
    : [query];

  for (const candidate of candidates) {
    try {
      const rows = await sql.unsafe(`EXPLAIN (FORMAT TEXT) ${candidate}`);
      const plan = rows
        .map((row: Record<string, unknown>) => Object.values(row)[0])
        .join('\n');
      return { plan, hasSeqScan: /Seq Scan/.test(plan) };
    } catch {
      // try next candidate / give up
    }
  }
  return null;
}
