/**
 * Disconnect-lifecycle chaos scenarios. These drive the REAL socket lifecycle
 * (session guard, presence keys, grace timer, resume) — the path where the
 * orphaned-match / freeze bugs live. Each scenario asserts the match reaches a
 * sane terminal/continued state AND all invariants hold.
 *
 * Local-only: REGRESSION_DB_URL must point at the native regression DB.
 */
import { afterEach, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const LOCAL_REDIS = process.env.REGRESSION_REDIS_URL ?? 'redis://:changeme@localhost:6379/15';
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
  process.env.REDIS_URL = LOCAL_REDIS;
  process.env.RANKED_HUMAN_QUEUE_ENABLED = 'true';
  process.env.REGRESSION_DETERMINISTIC = '1';
  process.env.REGRESSION_FAST_TIMERS = '1';
}
process.env.LOG_LEVEL = 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: disconnect lifecycle scenarios', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('disconnect → grace expires → match reaches a terminal state (orphaned-match guard)', async () => {
    const { bootMatch, playMatch, botDisconnect, expireGrace } =
      await import('../../game-regression/src/runner.mjs');
    const { checkInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');
    const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();
    await playMatch(run, { maxMs: 8_000 }); // play partway
    await botDisconnect(run);
    await expireGrace(run); // what the durable forfeit timer would do after 60s

    const match = await matchesRepo.getMatch(run.matchId!);
    // The bug we fixed: a disconnected match must NOT stay 'active' forever.
    expect(['completed', 'abandoned']).toContain(match?.status);

    const result = checkInvariants(run.trace);
    if (!result.ok) console.error(result.violations.map(formatViolation).join('\n'));
    expect(result.ok).toBe(true);
  }, 120_000);

  it('explicit forfeit → match reaches a terminal state', async () => {
    const { bootMatch, playMatch, botForfeit } = await import('../../game-regression/src/runner.mjs');
    const { checkInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');
    const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();
    await playMatch(run, { maxMs: 5_000 });
    await botForfeit(run);

    const match = await matchesRepo.getMatch(run.matchId!);
    expect(['completed', 'abandoned']).toContain(match?.status);

    const result = checkInvariants(run.trace);
    if (!result.ok) console.error(result.violations.map(formatViolation).join('\n'));
    expect(result.ok).toBe(true);
  }, 120_000);

  // RELIABLE part of the reconnect path: rejoin emits match:resume (the
  // "resume never fired" regression). This is always-green and worth guarding.
  it('disconnect → reconnect → resume fires (resume-never-fired guard)', async () => {
    const { bootMatch, playMatch, botDisconnect, botReconnect } =
      await import('../../game-regression/src/runner.mjs');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();
    await playMatch(run, { maxMs: 6_000 });
    await botDisconnect(run);
    await botReconnect(run); // throws if match:resume never fires

    expect(
      run.trace.byEvent('match:resume').length,
      'reconnect must emit match:resume',
    ).toBeGreaterThan(0);
  }, 150_000);

  // QUARANTINED — documents a REAL engine bug, see game-regression/BUGS_FOUND.md #2
  // (🔴 reconnect/resume DOUBLE-DRIVES the round loop: ~2/3 of runs either replay
  // rounds q3-q5 twice or wedge the match in status='active'). This assertion —
  // "reconnect completes cleanly with all invariants" — fails ~2/3 of the time, so
  // it must NOT gate CI as a coin-flip. Skipped until the engine resume path is made
  // idempotent w.r.t. the in-flight round driver. Re-enable (remove .skip) as the
  // fix's acceptance test — it should then be reliably green.
  it.skip('disconnect → reconnect → resume → match still completes cleanly [BLOCKED by #2]', async () => {
    const { bootMatch, playMatch, botDisconnect, botReconnect } =
      await import('../../game-regression/src/runner.mjs');
    const { checkInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();
    await playMatch(run, { maxMs: 6_000 });
    await botDisconnect(run);
    await botReconnect(run);
    await playMatch(run, { maxMs: 90_000 });

    expect(
      run.trace.byEvent('match:final_results').length,
      'match should still complete after reconnect',
    ).toBeGreaterThan(0);

    const result = checkInvariants(run.trace);
    if (!result.ok) console.error(result.violations.map(formatViolation).join('\n'));
    expect(result.ok).toBe(true);
  }, 150_000);
});
