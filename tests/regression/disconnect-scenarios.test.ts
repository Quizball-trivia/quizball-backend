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
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

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

  // Acceptance guard for the full resume path: after the reconnect UI-ready ack,
  // the current round must resume once and the match must still reach final
  // results without duplicate dispatches or an active-match wedge.
  it('disconnect → reconnect → resume → match still completes cleanly', async () => {
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

  // Bug 2 & 3 regression: a single disconnect episode must increment the
  // reconnect counter exactly once. One logical disconnect can drive the pause
  // path from two sources (socket `disconnect` + `match:leave`); before the fix
  // each bumped the counter, so two real disconnects forfeited a player after
  // only 2 (limit 3) — and a player who'd reconnected lost while online.
  it('a single disconnect episode counts the reconnect once (no double-count)', async () => {
    const { bootMatch, playMatch } = await import('../../game-regression/src/runner.mjs');
    const { pauseMatchForDisconnectedPlayer, getDisconnectCount } =
      await import('../../src/realtime/services/match-disconnect.service.js');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();
    await playMatch(run, { maxMs: 5_000 });

    // Simulate a real network drop: remove the live match socket so the
    // stable-socket guard can no longer treat the user as present.
    run.io.removeSocket(run.botSocket);

    // One logical disconnect drives the pause path from BOTH sources (the socket
    // `disconnect` handler + the `match:leave` path). Without the episode dedupe
    // each call re-increments the reconnect counter → count reaches 2 for a
    // single disconnect, forfeiting players a disconnect early.
    await pauseMatchForDisconnectedPlayer(run.io as never, run.matchId!, run.botUserId, { ignoreSocketId: 'src-a' });
    await pauseMatchForDisconnectedPlayer(run.io as never, run.matchId!, run.botUserId, { ignoreSocketId: 'src-b' });

    const count = await getDisconnectCount(run.matchId!, run.botUserId);
    expect(count, 'one disconnect episode must count exactly once').toBe(1);
  }, 120_000);

  // Bug 2 regression: a player who reconnected and is back in the match must NOT
  // be force-forfeited by a stale/duplicate disconnect handler. After reconnect
  // the count must not climb past the single original episode, and the match
  // must not be finalized as a forfeit while the player is present.
  it('does not forfeit a reconnected player who is back online', async () => {
    const { bootMatch, playMatch, botDisconnect, botReconnect } =
      await import('../../game-regression/src/runner.mjs');
    const { pauseMatchForDisconnectedPlayer, getDisconnectCount } =
      await import('../../src/realtime/services/match-disconnect.service.js');
    const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');
    const { recordMatchStagePresenceHeartbeat } =
      await import('../../src/realtime/services/match-stage-presence.service.js');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();
    await playMatch(run, { maxMs: 6_000 });

    // Capture the OLD socket's connect time, then disconnect + reconnect.
    const oldConnectedAt = run.botSocket.data.connectedAt as number;
    await botDisconnect(run);
    await botReconnect(run);
    run.botSocket.data.connectedAt = Date.now() - 6000;
    await recordMatchStagePresenceHeartbeat({
      matchId: run.matchId!,
      userId: run.botUserId,
      stageKey: 'question',
      socketId: run.botSocket.id,
    });
    const afterReconnect = await getDisconnectCount(run.matchId!, run.botUserId);

    // A STALE disconnect handler for the OLD (superseded) socket fires after the
    // user already reconnected — exactly the production path, which passes the
    // old socket's connectedAt AND autoResumeReplacementSocket. A newer same-user
    // socket exists, so the user is present: this must NOT count as a new
    // disconnect or forfeit them.
    await pauseMatchForDisconnectedPlayer(run.io as never, run.matchId!, run.botUserId, {
      ignoreSocketId: 'old-stale-socket',
      disconnectedConnectedAt: oldConnectedAt,
      autoResumeReplacementSocket: true,
    });
    const afterStale = await getDisconnectCount(run.matchId!, run.botUserId);

    expect(afterStale, 'a present (reconnected) player must not accrue more disconnects')
      .toBe(afterReconnect);

    const match = await matchesRepo.getMatch(run.matchId!);
    expect(match?.status, 'a reconnected, present player must not be forfeited')
      .toBe('active');
  }, 150_000);
});
