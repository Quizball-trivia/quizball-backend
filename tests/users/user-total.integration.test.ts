/**
 * Integration tests for usersRepo.getUserTotal.
 *
 * total = registered (non-guest, real) + guest journeys that played
 *         - played journeys later linked to an account (converters, new or
 *           existing, counted once).
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/users/user-total.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let usersRepo: typeof import('../../src/modules/users/users.repo.js').usersRepo;
let dbAvailable = false;

const testUserIds: string[] = [];
const testGuestIds: string[] = [];

async function insertUser(nickname: string, isGuest: boolean): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, is_seed, onboarding_complete, is_deleted, is_guest)
    VALUES (${nickname}, false, false, true, false, ${isGuest})
    RETURNING id
  `;
  testUserIds.push(row.id);
  return row.id;
}

async function insertJourney(guestId: string, played: boolean, link: { type: 'signup' | 'existing_member'; userId: string } | null): Promise<void> {
  testGuestIds.push(guestId);
  await sql`
    INSERT INTO guest_journeys (guest_id, created_at, first_play_at, linked_user_id, linked_at, link_type)
    VALUES (
      ${guestId}::uuid,
      NOW(),
      ${played ? sql`NOW()` : null},
      ${link ? link.userId : null},
      ${link ? sql`NOW()` : null},
      ${link ? link.type : null}
    )
  `;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;

    const repoModule = await import('../../src/modules/users/users.repo.js');
    usersRepo = repoModule.usersRepo;
  } catch (error) {
    if (process.env.RELEASE_TEST_DATABASE_URL) throw error;
    console.warn(
      '\n⚠️  Skipping user-total integration tests: Database not available.\n' +
        '   Run `npm run docker:start` to start the test database.\n'
    );
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testGuestIds.length > 0) {
    await sql`DELETE FROM guest_journeys WHERE guest_id = ANY(${testGuestIds}::uuid[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
});

describe('usersRepo.getUserTotal', () => {
  it('counts registered + played journeys minus converters exactly once', async () => {
    if (!dbAvailable) return;
    const before = await usersRepo.getUserTotal();

    const suffix = randomUUID().slice(0, 8);
    const regId = await insertUser(`total-reg-${suffix}`, false);
    await insertUser(`total-reg2-${suffix}`, false);
    await insertUser(`total-ghost-${suffix}`, true);
    // Played, never converted.
    await insertJourney(randomUUID(), true, null);
    // Played, then signed up (converter — must not be double-counted).
    await insertJourney(randomUUID(), true, { type: 'signup', userId: regId });
    // Played, then linked to an existing member (also a converter).
    await insertJourney(randomUUID(), true, { type: 'existing_member', userId: regId });
    // Never played — excluded entirely.
    await insertJourney(randomUUID(), false, null);

    const after = await usersRepo.getUserTotal();
    // +2 registered (the is_guest row is not registered), +1 played journey net
    // (+3 played, -2 converters), +2 converters.
    expect(after.registered - before.registered).toBe(2);
    expect(after.guestsPlayed - before.guestsPlayed).toBe(3);
    expect(after.converters - before.converters).toBe(2);
    expect(after.total - before.total).toBe(3);
    expect(after.total).toBe(after.registered + after.guestsPlayed - after.converters);
  });
});
