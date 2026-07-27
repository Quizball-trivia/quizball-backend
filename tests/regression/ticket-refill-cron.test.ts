/**
 * Real-DB integration: the global ticket-refill cron function.
 *
 * Verifies the bounded compatibility function against local Postgres: +1 ticket
 * for every due REAL user under MAX (5), with full/not-due/AI/deleted/pending
 * users skipped and the four-hour anchor advanced.
 *
 * Requires the local NATIVE stack (REGRESSION_DB_URL on localhost). The function
 * DDL is created here from the same body as the migration (we skip the
 * cron.schedule line so the test doesn't need the pg_cron extension).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
  process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://regression.supabase.co';
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? 'regression-anon-key';
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? 'http://localhost:3000';
  process.env.PORT = process.env.PORT ?? '8000';
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

// Function body mirrors supabase/migrations/20260714210000_batch_global_ticket_refill.sql
// (without the cron.schedule / extension lines).
const FUNCTION_DDL = `
CREATE OR REPLACE FUNCTION public.refill_tickets_global()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  refilled_count integer := 0;
BEGIN
  WITH refill_batch AS MATERIALIZED (
    SELECT u.id
    FROM public.users AS u
    WHERE u.tickets < 5
      AND u.tickets_refill_started_at IS NOT NULL
      AND u.tickets_refill_started_at <= clock_timestamp() - INTERVAL '4 hours'
      AND u.is_ai = false
      AND u.is_deleted = false
      AND u.deleted_at IS NULL
      AND u.pending_deletion_at IS NULL
    ORDER BY u.id
    LIMIT 500
    FOR UPDATE OF u SKIP LOCKED
  ), refilled AS (
    UPDATE public.users AS u
    SET tickets = u.tickets + 1,
        tickets_refill_started_at = CASE
          WHEN u.tickets + 1 >= 5 THEN NULL
          ELSE u.tickets_refill_started_at + INTERVAL '4 hours'
        END,
        updated_at = clock_timestamp()
    FROM refill_batch AS batch
    WHERE u.id = batch.id
      AND u.tickets < 5
      AND u.tickets_refill_started_at IS NOT NULL
      AND u.tickets_refill_started_at <= clock_timestamp() - INTERVAL '4 hours'
    RETURNING 1
  )
  SELECT count(*)::integer INTO refilled_count FROM refilled;
  RETURN refilled_count;
END;
$fn$;
`;

describeLocal('regression: refill_tickets_global() cron', () => {
  let sql: (typeof import('../../src/db/index.js'))['sql'];
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ({ sql } = await import('../../src/db/index.js'));
    await sql.unsafe(FUNCTION_DDL);
  });

  afterAll(async () => {
    await sql`DELETE FROM public.users WHERE id = ANY(${Object.values(ids)}::uuid[])`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    // Clean slate for this test's rows, then seed one user per scenario.
    await sql`DELETE FROM public.users WHERE nickname LIKE 'reg-refill-%'`;
    const seed = async (
      key: string,
      tickets: number,
      flags: {
        is_ai?: boolean;
        is_deleted?: boolean;
        deleted_at?: boolean;
        pending?: boolean;
        due?: boolean;
      } = {}
    ) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO public.users (
          email, nickname, tickets, tickets_refill_started_at,
          is_ai, is_deleted, deleted_at, pending_deletion_at
        )
        VALUES (
          ${`reg-refill-${key}@test.local`},
          ${`reg-refill-${key}`},
          ${tickets},
          ${flags.due === false ? sql`NOW() - INTERVAL '1 hour'` : sql`NOW() - INTERVAL '8 hours'`},
          ${flags.is_ai ?? false},
          ${flags.is_deleted ?? false},
          ${flags.deleted_at ? sql`NOW()` : null},
          ${flags.pending ? sql`NOW()` : null}
        )
        RETURNING id
      `;
      ids[key] = row.id;
    };

    await seed('empty', 0);
    await seed('mid', 3);
    await seed('not_due', 2, { due: false });
    await seed('full', 5);
    await seed('ai', 0, { is_ai: true });
    await seed('deleted', 0, { is_deleted: true });
    await seed('deleted_at', 0, { deleted_at: true });
    await seed('pending', 0, { pending: true });
  });

  async function ticketsOf(key: string): Promise<number> {
    const [row] = await sql<{ tickets: number }[]>`SELECT tickets FROM public.users WHERE id = ${ids[key]}`;
    return row.tickets;
  }

  async function anchorOf(key: string): Promise<string | null> {
    const [row] = await sql<{ tickets_refill_started_at: string | null }[]>`
      SELECT tickets_refill_started_at::text
      FROM public.users
      WHERE id = ${ids[key]}
    `;
    return row.tickets_refill_started_at;
  }

  it('grants +1 to real users under the cap', async () => {
    await sql`SELECT public.refill_tickets_global()`;
    expect(await ticketsOf('empty')).toBe(1);
    expect(await ticketsOf('mid')).toBe(4);
  });

  it('skips wallets whose refill interval is not due', async () => {
    await sql`SELECT public.refill_tickets_global()`;
    expect(await ticketsOf('not_due')).toBe(2);
  });

  it('advances the anchor one interval and clears it at the cap', async () => {
    const before = Date.parse((await anchorOf('mid'))!);
    await sql`SELECT public.refill_tickets_global()`;

    expect(Date.parse((await anchorOf('mid'))!)).toBe(before + 4 * 60 * 60 * 1000);

    await sql`
      UPDATE public.users
      SET tickets = 4,
          tickets_refill_started_at = NOW() - INTERVAL '8 hours'
      WHERE id = ${ids['empty']}
    `;
    await sql`SELECT public.refill_tickets_global()`;
    expect(await anchorOf('empty')).toBeNull();
  });

  it('does NOT exceed the cap — full users are untouched', async () => {
    await sql`SELECT public.refill_tickets_global()`;
    expect(await ticketsOf('full')).toBe(5);
  });

  it('excludes AI, deleted, deleted_at, and pending-deletion users', async () => {
    await sql`SELECT public.refill_tickets_global()`;
    expect(await ticketsOf('ai')).toBe(0);
    expect(await ticketsOf('deleted')).toBe(0);
    expect(await ticketsOf('deleted_at')).toBe(0);
    expect(await ticketsOf('pending')).toBe(0);
  });

  it('is additive across ticks but never overshoots 5 (4 -> 5, then stays)', async () => {
    await sql`
      UPDATE public.users
      SET tickets = 4,
          tickets_refill_started_at = NOW() - INTERVAL '8 hours'
      WHERE id = ${ids['empty']}
    `;
    await sql`SELECT public.refill_tickets_global()`; // 4 -> 5
    expect(await ticketsOf('empty')).toBe(5);
    await sql`SELECT public.refill_tickets_global()`; // 5 -> skipped
    expect(await ticketsOf('empty')).toBe(5);
  });

  it('returns the number of rows refilled', async () => {
    const [{ refill_tickets_global: count }] =
      await sql<{ refill_tickets_global: number }[]>`SELECT public.refill_tickets_global()`;
    // empty + mid are the only two eligible seeded rows (others are not due,
    // full, AI, deleted, or pending deletion).
    // There may be other pre-existing real users in the regression DB under cap,
    // so assert it at least counted our two.
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
