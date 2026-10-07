/**
 * Stat Sniper (Aproximado) board eligibility matches the other daily boards: an account pending deletion (locked),
 * an already-deleted, seed or guest account is neither listed nor counted in a player's rank (staging 2026-10-07:
 * a removed QA account kept showing on the public board).
 *
 * Run with the local test DB (tests/setup): npx vitest run tests/daily-challenges/stat-sniper-board-eligibility.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let repo: typeof import('../../src/modules/daily-challenges/daily-challenges.repo.js').dailyChallengesRepo;
let dbAvailable = false;
const DAY = '2001-01-01';
const ids: Record<string, string> = {};

async function user(key: string, flags: { is_seed?: boolean; is_guest?: boolean; pending?: boolean; deleted?: boolean }, score: number) {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, onboarding_complete, is_seed, is_guest, deleted_at, pending_deletion_at)
    VALUES (${`board_${key}_${Date.now() % 1e6}`}, true, ${flags.is_seed ?? false}, ${flags.is_guest ?? false},
            ${flags.deleted ? sql`now()` : null}, ${flags.pending ? sql`now()` : null})
    RETURNING id`;
  ids[key] = row!.id;
  await sql`INSERT INTO daily_challenge_completions (user_id, challenge_type, challenge_day, score) VALUES (${row!.id}, 'statSniper', ${DAY}, ${score})`;
}

beforeAll(async () => {
  try {
    ({ sql } = await import('../../src/db/index.js'));
    ({ dailyChallengesRepo: repo } = await import('../../src/modules/daily-challenges/daily-challenges.repo.js'));
    await sql`SELECT 1`;
    dbAvailable = true;
  } catch {
    return;
  }
  // Every ineligible account outscores the real player, so a leak shows up as a higher rank or an extra row.
  await user('real', {}, 50);
  await user('pending', { pending: true }, 99);
  await user('deleted', { deleted: true }, 98);
  await user('seed', { is_seed: true }, 97);
  await user('guest', { is_guest: true }, 96);
});

afterAll(async () => {
  if (!dbAvailable) return;
  const all = Object.values(ids);
  if (all.length) {
    await sql`DELETE FROM daily_challenge_completions WHERE user_id IN ${sql(all)}`;
    await sql`DELETE FROM users WHERE id IN ${sql(all)}`;
  }
});

describe('Stat Sniper board eligibility', () => {
  it('lists only eligible accounts', async (ctx) => {
    if (!dbAvailable) ctx.skip();
    const rows = await repo.listTopCompletionsForDay('statSniper', DAY, 10);
    expect(rows.map((r) => r.user_id)).toEqual([ids.real]);
  });

  it('ranks a player among eligible accounts only', async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await expect(repo.getCompletionRankForDay(ids.real!, 'statSniper', DAY)).resolves.toEqual({ rank: 1, score: 50, total: 1 });
  });
});
