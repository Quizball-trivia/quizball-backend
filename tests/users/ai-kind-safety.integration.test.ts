/**
 * Integration tests for the persistent-bot safety rails.
 *
 * The roster guarantee is structural: NO destructive automation may accept an
 * ai_kind='persistent' row. These tests prove each path refuses:
 *   - usersRepo.deleteAiUser        (kind allowlist in the DELETE predicate)
 *   - usersRepo.requestDeletion     (account deletion is a human-only flow)
 *   - cleanup_ai_users()            (SQL victim selection allowlist)
 *
 * cleanupOldDevMatches is covered in matches.service.orchestrators.integration.
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/users/ai-kind-safety.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let usersRepo: typeof import('../../src/modules/users/users.repo.js').usersRepo;
let dbAvailable = false;

const testUserIds: string[] = [];

async function insertAiUser(opts: {
  nickname: string;
  aiKind: 'ephemeral' | 'persistent' | 'auction';
  createdDaysAgo?: number;
  tx?: typeof sql;
}): Promise<string> {
  const runner = opts.tx ?? sql;
  const [row] = await runner<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, onboarding_complete, created_at)
    VALUES (
      ${opts.nickname},
      true,
      ${opts.aiKind},
      true,
      NOW() - (${opts.createdDaysAgo ?? 0}::int * INTERVAL '1 day')
    )
    RETURNING id
  `;
  if (!opts.tx) testUserIds.push(row.id);
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
      '\n⚠️  Skipping ai-kind safety integration tests: Database not available.\n' +
        '   Run `npm run docker:start` to start the test database.\n'
    );
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testUserIds.length > 0) {
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
  await sql.end();
});

describe('usersRepo.deleteAiUser', () => {
  it('deletes ephemeral and auction bots but refuses persistent', async ({ skip }) => {
    if (!dbAvailable) skip();

    const ephemeral = await insertAiUser({ nickname: 'aikind_del_eph', aiKind: 'ephemeral' });
    const auction = await insertAiUser({ nickname: 'aikind_del_auc', aiKind: 'auction' });
    const persistent = await insertAiUser({ nickname: 'aikind_del_per', aiKind: 'persistent' });

    expect(await usersRepo.deleteAiUser(ephemeral)).toBe(true);
    expect(await usersRepo.deleteAiUser(auction)).toBe(true);
    expect(await usersRepo.deleteAiUser(persistent)).toBe(false);

    const survivors = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE id = ANY(${[ephemeral, auction, persistent]}::uuid[])
    `;
    expect(survivors.map((r) => r.id)).toEqual([persistent]);
  });
});

describe('usersRepo.requestDeletion', () => {
  it('refuses to schedule any AI user for account deletion', async ({ skip }) => {
    if (!dbAvailable) skip();

    const persistent = await insertAiUser({ nickname: 'aikind_req_per', aiKind: 'persistent' });
    const result = await usersRepo.requestDeletion(persistent);
    expect(result).toBeNull();

    const [row] = await sql<{ pending_deletion_at: string | null }[]>`
      SELECT pending_deletion_at FROM users WHERE id = ${persistent}
    `;
    expect(row.pending_deletion_at).toBeNull();
  });
});

describe('cleanup_ai_users()', () => {
  it('drains an aged ephemeral bot but never selects a persistent bot', async ({ skip }) => {
    if (!dbAvailable) skip();

    // Runs the REAL cleanup function inside a rolled-back transaction: it may
    // delete other aged ephemeral rows in the shared dev DB, so nothing here
    // is allowed to persist.
    let persistentSurvived = false;
    let ephemeralDeleted = false;
    const rollback = Symbol('rollback');

    await sql
      .begin(async (tx) => {
        const persistent = await insertAiUser({
          nickname: 'aikind_cln_per',
          aiKind: 'persistent',
          createdDaysAgo: 8,
          tx: tx as unknown as typeof sql,
        });
        const ephemeral = await insertAiUser({
          nickname: 'aikind_cln_eph',
          aiKind: 'ephemeral',
          createdDaysAgo: 8,
          tx: tx as unknown as typeof sql,
        });

        await tx`SELECT cleanup_ai_users()`;

        const rows = await tx<{ id: string }[]>`
          SELECT id FROM users WHERE id = ANY(${[persistent, ephemeral]}::uuid[])
        `;
        const ids = rows.map((r) => r.id);
        persistentSurvived = ids.includes(persistent);
        ephemeralDeleted = !ids.includes(ephemeral);

        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });

    expect(persistentSurvived).toBe(true);
    expect(ephemeralDeleted).toBe(true);
  });
});
