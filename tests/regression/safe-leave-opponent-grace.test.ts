/**
 * Safe-leave regression for the two-player disconnect grace edge:
 * player B drops, player A leaves while B is still in grace. Player A must be
 * treated as present-by-proxy until B's original grace resolves; if B returns,
 * A gets their own normal grace instead of losing instantly.
 *
 * Local-only: opt in with REGRESSION_DB_URL pointing at the native local DB.
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
process.env.LOG_LEVEL = process.env.HARNESS_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

function winnerDecisionMethod(match: { state_payload?: unknown } | null): string | null {
  const payload = match?.state_payload;
  if (!payload || typeof payload !== 'object') return null;
  const method = (payload as { winnerDecisionMethod?: unknown }).winnerDecisionMethod;
  return typeof method === 'string' ? method : null;
}

describeLocal('regression: safe leave during opponent disconnect grace', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('opponent disconnects -> player leaves safely -> original disconnector forfeits on grace expiry', async () => {
    const { bootFriendlyLobbyMatch } = await import('../../game-regression/src/runner.mjs');
    const { checkInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');
    const { getRedisClient } = await import('../../src/realtime/redis.js');
    const { matchDisconnectKey, matchExitPendingKey } = await import('../../src/realtime/match-keys.js');
    const { resolveExpiredGraceWindow } =
      await import('../../src/realtime/services/match-disconnect.service.js');
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');

    const run = await bootFriendlyLobbyMatch({ variant: 'friendly_possession', startTimeoutMs: 25_000 });
    expect(run.matchId, 'host start should produce a match').toBeTruthy();

    run.io.removeSocket(run.joinerSocket);
    await matchRealtimeService.handleMatchDisconnect(run.io as never, run.joinerSocket as never);
    await matchRealtimeService.handleMatchLeave(run.io as never, run.hostSocket as never, run.matchId);
    run.io.removeSocket(run.hostSocket);

    const redis = getRedisClient();
    expect(redis, 'redis client should be initialized').toBeTruthy();
    expect(await redis!.exists(matchDisconnectKey(run.matchId!, run.joinerUserId))).toBe(1);
    expect(await redis!.exists(matchExitPendingKey(run.matchId!, run.hostUserId))).toBe(1);

    await resolveExpiredGraceWindow(run.io as never, run.matchId!, run.joinerUserId);

    const match = await matchesRepo.getMatch(run.matchId!);
    expect(match?.status).toBe('completed');
    expect(match?.winner_user_id).toBe(run.hostUserId);
    expect(winnerDecisionMethod(match)).toBe('forfeit');
    expect(await redis!.exists(matchDisconnectKey(run.matchId!, run.joinerUserId))).toBe(0);
    expect(await redis!.exists(matchExitPendingKey(run.matchId!, run.hostUserId))).toBe(0);

    const result = checkInvariants(run.trace);
    if (!result.ok) console.error(result.violations.map(formatViolation).join('\n'));
    expect(result.ok).toBe(true);
  }, 120_000);

  it('opponent reconnects -> safe leaver receives normal grace and forfeits only if they stay gone', async () => {
    const { bootFriendlyLobbyMatch } = await import('../../game-regression/src/runner.mjs');
    const { checkInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');
    const { getRedisClient } = await import('../../src/realtime/redis.js');
    const { matchDisconnectKey, matchExitPendingKey } = await import('../../src/realtime/match-keys.js');
    const { resolveExpiredGraceWindow } =
      await import('../../src/realtime/services/match-disconnect.service.js');
    const { matchRealtimeService } = await import('../../src/realtime/services/match-realtime.service.js');
    const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');

    const run = await bootFriendlyLobbyMatch({ variant: 'friendly_possession', startTimeoutMs: 25_000 });
    expect(run.matchId, 'host start should produce a match').toBeTruthy();

    run.io.removeSocket(run.joinerSocket);
    await matchRealtimeService.handleMatchDisconnect(run.io as never, run.joinerSocket as never);
    await matchRealtimeService.handleMatchLeave(run.io as never, run.hostSocket as never, run.matchId);
    run.io.removeSocket(run.hostSocket);

    const redis = getRedisClient();
    expect(redis, 'redis client should be initialized').toBeTruthy();
    expect(await redis!.exists(matchDisconnectKey(run.matchId!, run.joinerUserId))).toBe(1);
    expect(await redis!.exists(matchExitPendingKey(run.matchId!, run.hostUserId))).toBe(1);

    const freshJoiner = run.io.createSocket(`joiner-rejoin-${Date.now()}`, {
      user: { id: run.joinerUserId },
      connectedAt: Date.now(),
      matchId: run.matchId!,
    });
    freshJoiner.join(`user:${run.joinerUserId}`);
    await matchRealtimeService.handleMatchRejoin(run.io as never, freshJoiner as never, run.matchId);

    expect(await redis!.exists(matchDisconnectKey(run.matchId!, run.joinerUserId))).toBe(0);
    expect(await redis!.exists(matchExitPendingKey(run.matchId!, run.hostUserId))).toBe(0);
    expect(await redis!.exists(matchDisconnectKey(run.matchId!, run.hostUserId))).toBe(1);

    await resolveExpiredGraceWindow(run.io as never, run.matchId!, run.hostUserId);

    const match = await matchesRepo.getMatch(run.matchId!);
    expect(match?.status).toBe('completed');
    expect(match?.winner_user_id).toBe(run.joinerUserId);
    expect(winnerDecisionMethod(match)).toBe('forfeit');

    const result = checkInvariants(run.trace);
    if (!result.ok) console.error(result.violations.map(formatViolation).join('\n'));
    expect(result.ok).toBe(true);
  }, 120_000);
});
