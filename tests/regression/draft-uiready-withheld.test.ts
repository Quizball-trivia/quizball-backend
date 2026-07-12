/**
 * Ranked-AI draft "ui_ready withheld" scenario. This intentionally runs without
 * REGRESSION_FAST_TIMERS because fast timers bypass draft UI-ready waits for the
 * high-volume harness. The point here is the real force-deadline path:
 *
 *   ranked queue -> AI fallback -> draft starts -> no draft:ui_ready ever arrives
 *
 * After the 45s UI-ready force deadline, the server must abort the ranked draft
 * before match creation. A regression would auto-ban for the human, complete the
 * draft, and start a ranked AI match the player never entered.
 *
 * Local-only: opt in with REGRESSION_DB_URL pointing at the native local DB.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const LOCAL_REDIS = process.env.REGRESSION_REDIS_URL ?? 'redis://:changeme@localhost:6379/15';
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
  process.env.REDIS_URL = LOCAL_REDIS;
  process.env.RANKED_HUMAN_QUEUE_ENABLED = 'true';
  process.env.REGRESSION_DETERMINISTIC = '1';
  delete process.env.REGRESSION_FAST_TIMERS;
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: ranked AI draft ui_ready withheld', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('aborts before match creation when the human never sends draft:ui_ready', async () => {
    // Pin ranked-AI search and AI-ban jitter to their minimum production delays.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const { bootMatch } = await import('../../game-regression/src/runner.mjs');
    const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');
    const { usersRepo } = await import('../../src/modules/users/users.repo.js');

    const result = await bootMatch({ startTimeoutMs: 70_000, autoClientReadyAcks: false });
    const eventNames = new Set(result.trace.events.map((event) => event.event));

    expect(result.matchId, 'withheld draft:ui_ready must not produce a match id').toBeNull();
    expect(result.trace.byEvent('match:start'), 'no match should start').toHaveLength(0);
    expect(result.trace.byEvent('match:question'), 'no questions should be dispatched').toHaveLength(0);
    expect(result.trace.byEvent('draft:complete'), 'draft should not complete').toHaveLength(0);
    expect(result.trace.byEvent('ranked:queue_left'), 'server should close the ranked search state').not.toHaveLength(0);
    expect(eventNames.has('draft:start'), 'scenario should have reached draft before aborting').toBe(true);

    const activeMatch = await matchesRepo.getActiveMatchForUser(result.botUserId);
    expect(activeMatch, 'no active match row should remain for the no-entry player').toBeNull();

    const botUser = await usersRepo.getById(result.botUserId);
    expect(botUser?.tickets, 'no-entry abort should not consume the ranked ticket').toBe(1);
  }, 90_000);
});
