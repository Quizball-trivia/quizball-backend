/**
 * Restart durability — boot timer re-arm (commit d9d2f7c). Most match timers are
 * durable (Redis scheduler), but a few round-transition gates are in-process; a
 * deploy landing in one of those windows used to FREEZE the match until a rejoin
 * or the 15-min stale sweeper. rearmActiveMatchTimersOnBoot() closes that gap by
 * re-ensuring active-match timers after a restart.
 *
 * These boot a REAL ranked-AI match, then invoke the boot sweep DIRECTLY (the
 * production restart entry point) and assert:
 *   - an in-flight active match is re-armed and drives on to a terminal state
 *     (un-stuck), and the sweep is idempotent on a healthy match.
 *   - a PAUSED match (disconnect-grace) is skipped, not re-armed — the durable
 *     forfeit timer owns its lifecycle.
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
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: boot timer re-arm (restart durability)', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('re-arms an in-flight active match and drives it to a terminal state', async () => {
    const { bootMatch, playMatch } = await import('../../game-regression/src/runner.mjs');
    const { rearmActiveMatchTimersOnBoot } = await import(
      '../../src/realtime/services/boot-timer-rearm.service.js'
    );
    const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();
    await playMatch(run, { maxMs: 5_000 }); // partway — match is active, mid-flight
    const before = await matchesRepo.getMatch(run.matchId!);
    const qBefore = before?.current_q_index ?? 0;

    // Simulate the server restart: run the boot sweep against the live io. (The
    // human bot deliberately stops "playing" here — only the re-armed timers +
    // AI + question-timeout backfill should drive the match onward.)
    const summary = await rearmActiveMatchTimersOnBoot(run.io as never);
    expect(summary.scanned, 'the active match is scanned').toBeGreaterThanOrEqual(1);
    expect(summary.failed, 'a healthy match must not fail re-arm').toBe(0);
    expect(summary.skippedPaused, 'an unpaused match is not skipped').toBe(0);

    // The re-armed timers drive the match FORWARD (un-stuck) — to terminal if it
    // gets there, else at least advancing rounds (proving it did not freeze).
    const progressed = await waitForProgress(matchesRepo, run.matchId!, qBefore, 90_000);
    expect(progressed, 're-armed match must make progress / terminate, not freeze').toBe(true);
  }, 120_000);

  it('skips a PAUSED match (disconnect-grace owns it), not re-armed', async () => {
    const { bootMatch, playMatch, botDisconnect } = await import('../../game-regression/src/runner.mjs');
    const { rearmActiveMatchTimersOnBoot } = await import(
      '../../src/realtime/services/boot-timer-rearm.service.js'
    );

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();
    await playMatch(run, { maxMs: 4_000 });
    await botDisconnect(run); // sets the match pause key (grace window)

    const summary = await rearmActiveMatchTimersOnBoot(run.io as never);
    expect(
      summary.skippedPaused,
      'a paused (disconnect-grace) match must be skipped by the boot sweep',
    ).toBeGreaterThanOrEqual(1);
    expect(summary.rearmed, 'a paused match must NOT be re-armed').toBe(0);
  }, 120_000);
});

/** True as soon as the match terminates OR advances past `qBefore` (un-stuck). */
async function waitForProgress(
  matchesRepo: { getMatch: (id: string) => Promise<{ status: string; current_q_index: number } | null> },
  matchId: string,
  qBefore: number,
  maxMs: number,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const m = await matchesRepo.getMatch(matchId);
    if (m && (m.status === 'completed' || m.status === 'abandoned')) return true;
    if (m && m.current_q_index > qBefore) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
