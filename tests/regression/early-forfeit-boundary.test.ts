import { afterEach, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const LOCAL_REDIS = process.env.REGRESSION_REDIS_URL ?? 'redis://localhost:6379/15';
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
  process.env.REDIS_URL = LOCAL_REDIS;
  process.env.RANKED_HUMAN_QUEUE_ENABLED = 'true';
  process.env.REGRESSION_DETERMINISTIC = '1';
  process.env.REGRESSION_FAST_TIMERS = '1';
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;
const BOT_USER_ID = '00000000-0000-0000-0000-0000000000b0';

describeLocal('regression: early-forfeit economy boundary', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('refunds the first three early forfeits, then penalizes the fourth', async () => {
    const { seedTestUserWithTicket } = await import('../../game-regression/src/fixtures.mjs');
    const { bootMatch, botForfeit, teardownRun } = await import('../../game-regression/src/runner.mjs');
    const { rankedService } = await import('../../src/modules/ranked/ranked.service.js');
    const { sql } = await import('../../src/db/index.js');

    await seedTestUserWithTicket({ userId: BOT_USER_ID, tickets: 1 });
    await sql`
      UPDATE users
      SET early_forfeit_count = 0,
          early_forfeit_window_started_at = NULL
      WHERE id = ${BOT_USER_ID}
    `;
    await rankedService.ensureProfile(BOT_USER_ID);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const run = await bootMatch({ botUserId: BOT_USER_ID, startTimeoutMs: 25_000 });
      expect(run.matchId).toBeTruthy();

      await botForfeit(run);

      const [match] = await sql<Array<{ status: string }>>`
        SELECT status FROM matches WHERE id = ${run.matchId}
      `;
      const [user] = await sql<Array<{ tickets: number; early_forfeit_count: number; early_forfeit_window_started_at: string | null }>>`
        SELECT tickets, early_forfeit_count, early_forfeit_window_started_at
        FROM users
        WHERE id = ${BOT_USER_ID}
      `;
      const rpRows = await sql<Array<{ delta_rp: number; result: string }>>`
        SELECT delta_rp, result
        FROM ranked_rp_changes
        WHERE match_id = ${run.matchId}
          AND user_id = ${BOT_USER_ID}
      `;

      expect(match?.status, `attempt ${attempt} should no-contest abandon`).toBe('abandoned');
      expect(user?.early_forfeit_count, `attempt ${attempt} counter`).toBe(attempt);
      expect(user?.early_forfeit_window_started_at, `attempt ${attempt} window`).toBeTruthy();
      if (attempt < 4) {
        expect(user?.tickets, `attempt ${attempt} ticket refunded`).toBe(1);
        expect(rpRows.length, `attempt ${attempt} no RP row`).toBe(0);
      } else {
        expect(user?.tickets, 'fourth early forfeit is not refunded').toBe(0);
        expect(rpRows).toHaveLength(1);
        expect(rpRows[0]).toMatchObject({ delta_rp: -100, result: 'loss' });
      }

      await teardownRun();
    }
  }, 240_000);
});
