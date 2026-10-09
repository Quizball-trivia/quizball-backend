/**
 * Integration tests for usersRepo.findTakenLowerNicknames.
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/users/users.repo.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getAiNicknamePool } from '../../src/realtime/ai-ranked.constants.js';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let usersRepo: typeof import('../../src/modules/users/users.repo.js').usersRepo;
let dbAvailable = false;

const testUserIds: string[] = [];
const testIdentitySubjects: string[] = [];
const POOL_SAMPLE = ['beaborjgali', 'leaborjgali', 'gioooo'] as const;

async function insertUser(opts: {
  nickname: string;
  isAi?: boolean;
  aiKind?: 'ephemeral' | 'persistent' | 'auction';
  isSeed?: boolean;
  isDeleted?: boolean;
  pendingDeletion?: boolean;
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (
      nickname,
      is_ai,
      ai_kind,
      is_seed,
      onboarding_complete,
      is_deleted,
      deleted_at,
      pending_deletion_at
    )
    VALUES (
      ${opts.nickname},
      ${opts.isAi ?? false},
      ${opts.isAi ? opts.aiKind ?? 'ephemeral' : null},
      ${opts.isSeed ?? false},
      true,
      ${opts.isDeleted ?? false},
      ${opts.isDeleted ? sql`NOW()` : null},
      ${opts.pendingDeletion ? sql`NOW()` : null}
    )
    RETURNING id
  `;
  testUserIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;

    const repoModule = await import('../../src/modules/users/users.repo.js');
    usersRepo = repoModule.usersRepo;
  } catch {
    console.warn(
      '\n⚠️  Skipping users repo integration tests: Database not available.\n' +
        '   Run `npm run docker:start` to start the test database.\n'
    );
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testIdentitySubjects.length > 0) {
    await sql`DELETE FROM user_identities WHERE subject = ANY(${testIdentitySubjects}::text[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
});

describe('usersRepo.findTakenLowerNicknames', () => {
  it('excludes seed users with AI-pool nicknames', async ({ skip }) => {
    if (!dbAvailable) skip();

    await insertUser({ nickname: 'beaborjgali', isSeed: true });

    const taken = await usersRepo.findTakenLowerNicknames([...POOL_SAMPLE]);
    expect(taken.has('beaborjgali')).toBe(false);
  });

  it('includes active real non-seed users with AI-pool nicknames', async ({ skip }) => {
    if (!dbAvailable) skip();

    await insertUser({ nickname: 'leaborjgali', isSeed: false, isAi: false });

    const taken = await usersRepo.findTakenLowerNicknames([...POOL_SAMPLE]);
    expect(taken.has('leaborjgali')).toBe(true);
  });

  it('excludes AI users with AI-pool nicknames', async ({ skip }) => {
    if (!dbAvailable) skip();

    await insertUser({ nickname: 'gioooo', isAi: true });

    const taken = await usersRepo.findTakenLowerNicknames([...POOL_SAMPLE]);
    expect(taken.has('gioooo')).toBe(false);
  });

  it('excludes deleted and pending-deletion real users', async ({ skip }) => {
    if (!dbAvailable) skip();

    await insertUser({ nickname: 'sabaaa', isDeleted: true });
    await insertUser({ nickname: 'cotneee', pendingDeletion: true });

    const taken = await usersRepo.findTakenLowerNicknames(['sabaaa', 'cotneee', 'benzooo']);
    expect(taken.has('sabaaa')).toBe(false);
    expect(taken.has('cotneee')).toBe(false);
  });

  it('returns empty set for empty input', async ({ skip }) => {
    if (!dbAvailable) skip();

    const taken = await usersRepo.findTakenLowerNicknames([]);
    expect(taken.size).toBe(0);
  });

  it('does not treat full AI pool as blocked when only seed users hold those nicknames', async ({ skip }) => {
    if (!dbAvailable) skip();

    const pool = [...getAiNicknamePool()];
    const seedOnlyNickname = pool[0];
    await insertUser({ nickname: seedOnlyNickname, isSeed: true });

    const taken = await usersRepo.findTakenLowerNicknames(pool);
    expect(taken.has(seedOnlyNickname.toLowerCase())).toBe(false);
  });
});

describe('usersRepo.createWithIdentity', () => {
  it('creates the account without a nickname when the provider name is already somebody else\'s nickname', async ({ skip }) => {
    if (!dbAvailable) skip();

    const name = `Taken Name ${Date.now()}`;
    const subjects = [`repo-name-a-${Date.now()}`, `repo-name-b-${Date.now()}`];
    testIdentitySubjects.push(...subjects);
    const first = await usersRepo.createWithIdentity({ email: null, nickname: name }, { provider: 'supabase', subject: subjects[0], email: null });
    // Same display name, another person, different letter case: a new account, not an error and not a merge.
    const second = await usersRepo.createWithIdentity({ email: null, nickname: name.toUpperCase() }, { provider: 'supabase', subject: subjects[1], email: null });
    testUserIds.push(first.user.id, second.user.id);

    expect(first).toMatchObject({ created: true, user: { nickname: name } });
    expect(second.created).toBe(true);
    expect(second.user.id).not.toBe(first.user.id);
    expect(second.user.nickname).toBeNull();
    const history = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM nickname_history WHERE user_id = ${second.user.id}`;
    expect(history[0].n).toBe(0);
    const identities = await sql<{ user_id: string }[]>`SELECT user_id FROM user_identities WHERE provider = 'supabase' AND subject = ${subjects[1]}`;
    expect(identities).toEqual([{ user_id: second.user.id }]);
  });

  it('is idempotent when first-login provisioning races on the same identity', async ({ skip }) => {
    if (!dbAvailable) skip();

    const subject = `repo-race-${Date.now()}`;
    const emailPrefix = `${subject}@example`;
    testIdentitySubjects.push(subject);

    const users = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        usersRepo.createWithIdentity(
          { email: `${emailPrefix}-${index}.com` },
          { provider: 'supabase', subject, email: `${emailPrefix}.com` },
        ),
      ),
    );
    const userIds = [...new Set(users.map(({ user }) => user.id))];
    testUserIds.push(...userIds);

    expect(userIds).toHaveLength(1);
    expect(users.filter((result) => result.created)).toHaveLength(1);

    const identities = await sql<{ user_id: string }[]>`
      SELECT user_id FROM user_identities
      WHERE provider = 'supabase' AND subject = ${subject}
    `;
    expect(identities).toEqual([{ user_id: userIds[0] }]);

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM users
      WHERE email LIKE ${`${emailPrefix}-%`}
        AND id <> ${userIds[0]}
    `;
    expect(count).toBe(0);
  });
});
