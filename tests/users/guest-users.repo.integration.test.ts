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
