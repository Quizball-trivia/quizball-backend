/**
 * Real-DB integration: the global ticket-refill cron function.
 *
 * Verifies `refill_tickets_global()` against local Postgres — the exact UPDATE
 * the `refill-tickets-every-4h` pg_cron job runs: +1 ticket for every REAL user
 * under MAX (5), full users skipped, guests / AI / deleted / pending-deletion excluded.
 *
 * Requires the migrated local stack (REGRESSION_DB_URL on localhost). Exercise
 * the installed candidate function; do not replace it with an older test copy.
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

describeLocal('regression: refill_tickets_global() cron', () => {
  let sql: (typeof import('../../src/db/index.js'))['sql'];
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ({ sql } = await import('../../src/db/index.js'));
    const [installed] = await sql`SELECT to_regprocedure('public.refill_tickets_global()') IS NOT NULL AS present`;
    expect(installed.present, 'Apply candidate migrations to the isolated database before this test').toBe(true);
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
      flags: { is_ai?: boolean; is_guest?: boolean; is_deleted?: boolean; deleted_at?: boolean; pending?: boolean } = {}
    ) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO public.users (email, nickname, tickets, is_ai, ai_kind, is_guest, is_deleted, deleted_at, pending_deletion_at)
        VALUES (
          ${`reg-refill-${key}@test.local`},
          ${`reg-refill-${key}`},
          ${tickets},
          ${flags.is_ai ?? false},
          ${flags.is_ai ? 'ephemeral' : null},
          ${flags.is_guest ?? false},
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
    await seed('full', 5);
    await seed('ai', 0, { is_ai: true });
    await seed('guest', 0, { is_guest: true });
    await seed('deleted', 0, { is_deleted: true });
    await seed('deleted_at', 0, { deleted_at: true });
    await seed('pending', 0, { pending: true });
  });

  async function ticketsOf(key: string): Promise<number> {
    const [row] = await sql<{ tickets: number }[]>`SELECT tickets FROM public.users WHERE id = ${ids[key]}`;
    return row.tickets;
  }

  it('grants +1 to real users under the cap', async () => {
    await sql`SELECT public.refill_tickets_global()`;
    expect(await ticketsOf('empty')).toBe(1);
    expect(await ticketsOf('mid')).toBe(4);
  });

  it('does NOT exceed the cap — full users are untouched', async () => {
    await sql`SELECT public.refill_tickets_global()`;
    expect(await ticketsOf('full')).toBe(5);
  });

  it('excludes guests, AI, deleted, deleted_at, and pending-deletion users', async () => {
    await sql`SELECT public.refill_tickets_global()`;
    expect(await ticketsOf('ai')).toBe(0);
    expect(await ticketsOf('guest')).toBe(0);
    expect(await ticketsOf('deleted')).toBe(0);
    expect(await ticketsOf('deleted_at')).toBe(0);
    expect(await ticketsOf('pending')).toBe(0);
  });

  it('is additive across ticks but never overshoots 5 (4 -> 5, then stays)', async () => {
    await sql`UPDATE public.users SET tickets = 4 WHERE id = ${ids['empty']}`;
    await sql`SELECT public.refill_tickets_global()`; // 4 -> 5
    expect(await ticketsOf('empty')).toBe(5);
    await sql`SELECT public.refill_tickets_global()`; // 5 -> skipped
    expect(await ticketsOf('empty')).toBe(5);
  });

  it('returns the number of rows refilled', async () => {
    const [{ refill_tickets_global: count }] =
      await sql<{ refill_tickets_global: number }[]>`SELECT public.refill_tickets_global()`;
    // empty + mid are the only two eligible seeded rows (others full/ai/deleted/pending).
    // There may be other pre-existing real users in the regression DB under cap,
    // so assert it at least counted our two.
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
