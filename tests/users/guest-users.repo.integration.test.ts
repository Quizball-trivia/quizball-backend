/**
 * Integration: atomic guest provisioning against the real schema.
 *   npm run docker:start && npx vitest run tests/users/guest-users.repo.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let usersRepo: typeof import('../../src/modules/users/users.repo.js').usersRepo;
let dbAvailable = false;
const cleanupUserIds: string[] = [];
const cleanupSubjects: string[] = [];

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    usersRepo = (await import('../../src/modules/users/users.repo.js')).usersRepo;
  } catch {
    console.warn('\n⚠️  Skipping guest users repo integration tests: Database not available.\n');
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (cleanupSubjects.length) await sql`DELETE FROM user_identities WHERE provider = 'guest' AND subject = ANY(${cleanupSubjects})`;
  if (cleanupUserIds.length) await sql`DELETE FROM users WHERE id = ANY(${cleanupUserIds})`;
  await sql.end({ timeout: 5 });
});

const subject = () => {
  const s = `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  cleanupSubjects.push(s);
  return s;
};

describe('usersRepo.createGuestWithIdentity', () => {
  it('inserts a flagged row with zero balances and a guest identity, idempotently', async () => {
    if (!dbAvailable) return;
    const s = subject();
    const first = await usersRepo.createGuestWithIdentity({ nicknameCandidates: [`Guesty ${s}`], avatarCustomization: { jersey: 'jersey_green' } }, { provider: 'guest', subject: s });
    cleanupUserIds.push(first.user.id);
    expect(first.created).toBe(true);
    expect(first.user.is_guest).toBe(true);
    expect(first.user.coins).toBe(0);
    expect(first.user.tickets).toBe(0);
    expect(first.user.is_ai).toBe(false);
    expect(first.user.nickname).toBe(`Guesty ${s}`);
    const [identity] = await sql<{ user_id: string }[]>`SELECT user_id FROM user_identities WHERE provider = 'guest' AND subject = ${s}`;
    expect(identity.user_id).toBe(first.user.id);
    const again = await usersRepo.createGuestWithIdentity({ nicknameCandidates: ['Other Name 1'] }, { provider: 'guest', subject: s });
    expect(again.created).toBe(false);
    expect(again.user.id).toBe(first.user.id);
  });

  it('walks the nickname candidates when one collides with a member (case-insensitively)', async () => {
    if (!dbAvailable) return;
    const s = subject();
    const taken = `Taken Name ${s}`;
    const [member] = await sql<{ id: string }[]>`INSERT INTO users (nickname, is_ai, onboarding_complete) VALUES (${taken}, false, true) RETURNING id`;
    cleanupUserIds.push(member.id);
    const guest = await usersRepo.createGuestWithIdentity({ nicknameCandidates: [taken.toUpperCase(), `Free Name ${s}`] }, { provider: 'guest', subject: s });
    cleanupUserIds.push(guest.user.id);
    expect(guest.created).toBe(true);
    expect(guest.user.nickname).toBe(`Free Name ${s}`);
  });

  it('fails cleanly (no orphan row) when every candidate is taken', async () => {
    if (!dbAvailable) return;
    const s = subject();
    const taken = `Only Name ${s}`;
    const [member] = await sql<{ id: string }[]>`INSERT INTO users (nickname, is_ai, onboarding_complete) VALUES (${taken}, false, true) RETURNING id`;
    cleanupUserIds.push(member.id);
    await expect(usersRepo.createGuestWithIdentity({ nicknameCandidates: [taken] }, { provider: 'guest', subject: s })).rejects.toThrow('Could not allocate a guest nickname');
    const rows = await sql`SELECT 1 FROM user_identities WHERE provider = 'guest' AND subject = ${s}`;
    expect(rows.length).toBe(0);
  });
});

describe('guest isolation against the real schema', () => {
  it('refill_tickets_global() skips guests (live and tombstoned) but still pays members', async () => {
    if (!dbAvailable) return;
    const s = subject();
    const guest = await usersRepo.createGuestWithIdentity({ nicknameCandidates: [`Cron Guest ${s}`] }, { provider: 'guest', subject: s });
    cleanupUserIds.push(guest.user.id);
    const [member] = await sql<{ id: string }[]>`INSERT INTO users (nickname, is_ai, onboarding_complete, tickets) VALUES (${`Cron Member ${s}`}, false, true, 3) RETURNING id`;
    cleanupUserIds.push(member.id);
    const [tombstone] = await sql<{ id: string }[]>`INSERT INTO users (nickname, is_ai, is_guest, onboarding_complete, tickets) VALUES (NULL, false, true, true, 0) RETURNING id`;
    cleanupUserIds.push(tombstone.id);

    await sql`SELECT refill_tickets_global()`;

    const rows = await sql<{ id: string; tickets: number }[]>`SELECT id, tickets FROM users WHERE id = ANY(${[guest.user.id, member.id, tombstone.id]})`;
    const tickets = Object.fromEntries(rows.map((r) => [r.id, r.tickets]));
    expect(tickets[guest.user.id]).toBe(0);
    expect(tickets[tombstone.id]).toBe(0);
    expect(tickets[member.id]).toBe(4);
  });

  it('retireSession tombstones the row, revokes the identity and deletes the session in one transaction', async () => {
    if (!dbAvailable) return;
    const { guestRepo } = await import('../../src/modules/guest/guest.repo.js');
    const session = await guestRepo.insert({ tokenHash: `h-${Date.now()}-${Math.random()}`.slice(0, 64), locale: 'en', ipHash: null, deviceHash: null });
    cleanupSubjects.push(session.id);
    const guest = await usersRepo.createGuestWithIdentity({ nicknameCandidates: [`Retire Guest ${session.id.slice(0, 8)}`], avatarCustomization: { jersey: 'jersey_blue' } }, { provider: 'guest', subject: session.id });
    cleanupUserIds.push(guest.user.id);

    expect(await guestRepo.retireSession(session.id, 'guest')).toEqual({ userId: guest.user.id });

    const [row] = await sql<{ nickname: string | null; avatar_customization: unknown; is_guest: boolean }[]>`SELECT nickname, avatar_customization, is_guest FROM users WHERE id = ${guest.user.id}`;
    expect(row).toMatchObject({ nickname: null, avatar_customization: null, is_guest: true });
    expect(await sql`SELECT 1 FROM user_identities WHERE provider = 'guest' AND subject = ${session.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM guest_sessions WHERE id = ${session.id}`).toHaveLength(0);
    // Daily-only session (no users row): just deleted.
    const daily = await guestRepo.insert({ tokenHash: `d-${Date.now()}-${Math.random()}`.slice(0, 64), locale: null, ipHash: null, deviceHash: null });
    expect(await guestRepo.retireSession(daily.id, 'guest')).toEqual({ userId: null });
    expect(await sql`SELECT 1 FROM guest_sessions WHERE id = ${daily.id}`).toHaveLength(0);
  });
});
