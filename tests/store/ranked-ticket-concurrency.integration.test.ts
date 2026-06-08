/**
 * DB-gated coverage for ranked ticket CAS behavior.
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/store/ranked-ticket-concurrency.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let storeService: typeof import('../../src/modules/store/store.service.js').storeService;
let ticketRefillService: typeof import('../../src/modules/store/ticket-refill.service.js').ticketRefillService;
let dbAvailable = false;

const testUserIds: string[] = [];

async function seedWallet(opts: {
  tickets: number;
  anchor?: string | null;
  coins?: number;
}): Promise<string> {
  const suffix = `${Date.now()}-${testUserIds.length}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (
      nickname,
      is_ai,
      onboarding_complete,
      coins,
      tickets,
      tickets_refill_started_at
    )
    VALUES (
      ${`ranked-ticket-cas-${suffix}`},
      false,
      true,
      ${opts.coins ?? 0},
      ${opts.tickets},
      ${opts.anchor ?? null}
    )
    RETURNING id
  `;
  testUserIds.push(row.id);
  return row.id;
}

async function getTickets(userId: string): Promise<number> {
  const [row] = await sql<{ tickets: number }[]>`
    SELECT tickets
    FROM users
    WHERE id = ${userId}
  `;
  return row.tickets;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;

    const storeModule = await import('../../src/modules/store/store.service.js');
    storeService = storeModule.storeService;

    const ticketRefillModule = await import('../../src/modules/store/ticket-refill.service.js');
    ticketRefillService = ticketRefillModule.ticketRefillService;
  } catch {
    console.warn(
      '\nSkipping ranked ticket CAS integration tests: Database not available.\n' +
        '   Run `npm run docker:start` to start the test database.\n'
    );
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testUserIds.length > 0) {
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
});

describe('ranked ticket CAS integration', () => {
  it('allows exactly three concurrent consumes from a three-ticket wallet', async ({ skip }) => {
    if (!dbAvailable) skip();

    const userId = await seedWallet({ tickets: 3, anchor: null });

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => storeService.consumeRankedTickets([userId]))
    );

    const successfulConsumes = attempts.filter(
      (attempt) => attempt.status === 'fulfilled' && attempt.value !== null
    );

    expect(successfulConsumes).toHaveLength(3);
    expect(await getTickets(userId)).toBe(0);
  });

  it('does not decrement either user when a two-player preflight finds one insufficient', async ({ skip }) => {
    if (!dbAvailable) skip();

    const readyUserId = await seedWallet({ tickets: 1, anchor: '2026-03-08T10:00:00.000Z' });
    const emptyUserId = await seedWallet({ tickets: 0, anchor: '2026-03-08T10:00:00.000Z' });

    const result = await storeService.consumeRankedTickets([readyUserId, emptyUserId]);

    expect(result).toBeNull();
    expect(await getTickets(readyUserId)).toBe(1);
    expect(await getTickets(emptyUserId)).toBe(0);
  });

  it('rolls back an earlier decrement when a later participant races to insufficient', async ({ skip }) => {
    if (!dbAvailable) skip();

    const firstUserId = await seedWallet({ tickets: 1, anchor: '2026-03-08T10:00:00.000Z' });
    const secondUserId = await seedWallet({ tickets: 1, anchor: '2026-03-08T10:00:00.000Z' });
    const [firstSortedUserId, secondSortedUserId] = [firstUserId, secondUserId].sort((left, right) =>
      left.localeCompare(right)
    );
    const raceAnchor = '2026-03-08T10:00:00.000Z';

    await expect(
      sql.begin(async (tx) => {
        for (const userId of [firstSortedUserId, secondSortedUserId]) {
          const wallet = await ticketRefillService.hydrateTicketsInTx(tx, userId, { now: raceAnchor });
          expect(wallet?.tickets).toBe(1);
        }

        const firstConsume = await ticketRefillService.consumeRankedTicketInTx(tx, firstSortedUserId, {
          now: raceAnchor,
        });
        expect(firstConsume.consumed).toBe(true);

        await sql`
          UPDATE users
          SET tickets = 0,
              tickets_refill_started_at = ${raceAnchor}
          WHERE id = ${secondSortedUserId}
        `;

        const secondConsume = await ticketRefillService.consumeRankedTicketInTx(tx, secondSortedUserId, {
          now: raceAnchor,
        });
        expect(secondConsume.consumed).toBe(false);

        throw new Error('ranked ticket consume failed after preflight');
      })
    ).rejects.toThrow('ranked ticket consume failed after preflight');

    expect(await getTickets(firstSortedUserId)).toBe(1);
    expect(await getTickets(secondSortedUserId)).toBe(0);
  });
});
