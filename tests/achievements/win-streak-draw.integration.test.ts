/**
 * Win-streak SQL vs no-winner matches. A drawn penalty shootout
 * (winner_user_id NULL, winnerDecisionMethod 'draw') must neither extend nor
 * break a streak; ANY other non-win — including a legacy/unclassified
 * no-winner match with a NULL decision — must break it. NULLs may never make
 * the predicate evaluate to unknown.
 *
 * Requires the test database (DATABASE_URL in setup.ts). Self-skips if absent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../setup.js';

const TAG = `wsd_${Date.now().toString(36)}`;
let sql: typeof import('../../src/db/index.js').sql;
let dbAvailable = false;
let achievementsRepo: typeof import('../../src/modules/achievements/achievements.repo.js').achievementsRepo;
let objectivesRepo: typeof import('../../src/modules/objectives/objectives.repo.js').objectivesRepo;

const PERIOD_START = new Date('2000-01-01T00:00:00Z');
const PERIOD_END = new Date('2100-01-01T00:00:00Z');
let userId: string;
let opponentId: string;
const matchIds: string[] = [];

type Outcome = 'win' | 'draw' | 'null_null' | 'loss';

async function seedUser(suffix: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai) VALUES (${`${TAG}_${suffix}`}, false) RETURNING id
  `;
  return row.id;
}

async function seedSequence(outcomes: Outcome[]): Promise<void> {
  const base = new Date('2026-09-01T00:00:00Z').getTime();
  for (const [i, outcome] of outcomes.entries()) {
    const winner = outcome === 'win' ? userId : outcome === 'loss' ? opponentId : null;
    const payload = outcome === 'draw' ? { winnerDecisionMethod: 'draw' } : null;
    const at = new Date(base + i * 60_000).toISOString();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO matches (mode, status, is_dev, started_at, ended_at, winner_user_id, state_payload)
      VALUES ('ranked', 'completed', false, ${at}::timestamptz, ${at}::timestamptz, ${winner}, ${payload === null ? null : sql.json(payload)})
      RETURNING id
    `;
    matchIds.push(row.id);
    await sql`INSERT INTO match_players (match_id, user_id, seat) VALUES (${row.id}, ${userId}, 1), (${row.id}, ${opponentId}, 2)`;
  }
}

async function clearMatches(): Promise<void> {
  if (matchIds.length === 0) return;
  await sql`DELETE FROM match_players WHERE match_id = ANY(${matchIds}::uuid[])`;
  await sql`DELETE FROM matches WHERE id = ANY(${matchIds}::uuid[])`;
  matchIds.length = 0;
}

async function streaks(): Promise<{ achievements: number; objectives: number; objectivesTx: number }> {
  const achievements = await achievementsRepo.getBestWinStreak(userId);
  const objectives = await objectivesRepo.getRankedWinStreakForPeriod(userId, PERIOD_START, PERIOD_END);
  const objectivesTx = await sql.begin(async (tx) =>
    objectivesRepo.getRankedWinStreakForPeriodInTx(tx as never, userId, PERIOD_START, PERIOD_END)
  );
  return { achievements, objectives, objectivesTx };
}

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1`;
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping win-streak draw integration test: database not available.\n');
    return;
  }
  achievementsRepo = (await import('../../src/modules/achievements/achievements.repo.js')).achievementsRepo;
  objectivesRepo = (await import('../../src/modules/objectives/objectives.repo.js')).objectivesRepo;
  userId = await seedUser('me');
  opponentId = await seedUser('opp');
});

afterAll(async () => {
  if (!dbAvailable) return;
  await clearMatches();
  await sql`DELETE FROM users WHERE id IN (${userId}, ${opponentId})`;
});

describe('best win streak across no-winner matches', () => {
  it('win → NULL winner with NULL decision → win: the unclassified no-winner match BREAKS the streak (1)', async () => {
    if (!dbAvailable) return;
    await clearMatches();
    await seedSequence(['win', 'null_null', 'win']);
    expect(await streaks()).toEqual({ achievements: 1, objectives: 1, objectivesTx: 1 });
  });

  it('win → draw → win: the drawn shootout neither extends nor breaks the streak (2)', async () => {
    if (!dbAvailable) return;
    await clearMatches();
    await seedSequence(['win', 'draw', 'win']);
    expect(await streaks()).toEqual({ achievements: 2, objectives: 2, objectivesTx: 2 });
  });

  it('win → loss → win → win: a real loss breaks it (2)', async () => {
    if (!dbAvailable) return;
    await clearMatches();
    await seedSequence(['win', 'loss', 'win', 'win']);
    expect(await streaks()).toEqual({ achievements: 2, objectives: 2, objectivesTx: 2 });
  });
});
