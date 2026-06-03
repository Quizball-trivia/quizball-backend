/**
 * High-risk integration: boot ONE real ranked-AI match in-process against the
 * LOCAL Supabase DB + Redis, and assert a match:start is observed.
 *
 * Requires the local stack:
 *   cd backend-node && supabase start         (Postgres :54322)
 *   docker compose up -d redis                (Redis :6379)
 *
 * Runs in REAL time but with REGRESSION_FAST_TIMERS=1, which collapses the
 * matchmaking/draft delays (7s/7s/16s) to a few ms — so the whole boot is < 1s.
 *
 * Gated to local: skipped unless REGRESSION_DB_URL points at a local host, so CI /
 * normal `npm test` never touch a remote DB.
 */
import { afterAll, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const LOCAL_REDIS = process.env.REGRESSION_REDIS_URL ?? 'redis://:changeme@localhost:6379';
const isLocal = /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

// The engine reads config at import time — set env BEFORE importing the runner.
process.env.NODE_ENV = 'local';
process.env.DATABASE_URL = LOCAL_DB;
process.env.REDIS_URL = LOCAL_REDIS;
process.env.RANKED_HUMAN_QUEUE_ENABLED = 'true';
process.env.REGRESSION_DETERMINISTIC = '1';
process.env.REGRESSION_FAST_TIMERS = '1';
process.env.LOG_LEVEL = 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: boot one real ranked-AI match', () => {
  afterAll(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('reaches match:start + first question through the real ranked-queue -> AI -> draft path', async () => {
    const { bootMatch } = await import('../../game-regression/src/runner.mjs');
    const result = await bootMatch({ startTimeoutMs: 10_000 });

    if (!result.matchId) {
      const names = [...new Set(result.trace.events.map((e) => e.event))];
      console.error('No match:start. Distinct events:', names);
    }

    expect(result.matchId, 'a match should have started').toBeTruthy();
    expect(result.trace.byEvent('match:start').length).toBeGreaterThan(0);
    // The full production boot path should have run: draft -> match -> first question.
    expect(result.trace.byEvent('draft:complete').length).toBeGreaterThan(0);
    expect(result.trace.byEvent('match:question').length).toBeGreaterThan(0);
  }, 20_000);
});
