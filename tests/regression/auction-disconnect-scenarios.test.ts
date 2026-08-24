import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { RunAuctionResult } from '../../game-regression/src/auction-runner.mjs';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const LOCAL_REDIS = process.env.REGRESSION_REDIS_URL ?? 'redis://:changeme@localhost:6379/15';
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
  process.env.REDIS_URL = LOCAL_REDIS;
  process.env.REGRESSION_DETERMINISTIC = '1';
  process.env.REGRESSION_FAST_TIMERS = '1';
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: auction multi-human disconnect scenarios', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    const { teardownAuctionRun } = await import('../../game-regression/src/auction-runner.mjs');
    await teardownAuctionRun();
  });

  it('2H+1B reconnects A within grace, resumes, and lets A bid without over-counting', async () => {
    const {
      bootAuctionMatch,
      disconnectAuctionHuman,
      finishAuctionMatch,
      loadCurrentAuctionState,
      reconnectAuctionHuman,
      waitForHumanTurn,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const { getAuctionDisconnectCount } = await import(
      '../../src/realtime/services/auction-disconnect-state.service.js'
    );
    const { getMinBid } = await import('../../src/modules/auction/auction-rules.js');
    const { handleAuctionBid } = await import('../../src/realtime/services/auction-turn.service.js');

    const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
    const [humanA, humanB] = run.humans;
    const turn = await waitForHumanTurn(run, {
      userId: humanA.userId,
      driveSeatIds: [humanB.seatId],
    });
    expect(turn.state.currentRound?.currentTurnSeatId).toBe(humanA.seatId);

    const disconnected = await disconnectAuctionHuman(run, humanA.userId);
    expect(disconnected.marker?.disconnectCount).toBe(1);
    expect(run.trace.byEvent('auction:paused').length).toBeGreaterThan(disconnected.pauseEventsBefore);

    await reconnectAuctionHuman(run, humanA.userId);
    expect(run.trace.byEvent('auction:resume').length).toBeGreaterThan(0);
    expect(run.trace.byEvent('auction:player_forfeited')).toHaveLength(0);
    expect(await getAuctionDisconnectCount(run.matchId!, humanA.userId)).toBe(1);

    const resumed = await loadCurrentAuctionState(run.matchId);
    expect(resumed?.phase).toBe('bidding');
    expect(resumed?.currentRound?.currentTurnSeatId).toBe(humanA.seatId);
    const amount = getMinBid(
      resumed!.currentRound!.startingPrice,
      resumed!.currentRound!.highestBid
    );
    const bid = await handleAuctionBid(run.io as never, humanA.socket as never, {
      matchId: run.matchId!,
      amount,
    });
    expect(bid?.kind).toBe('bid_accepted');
    expect(
      run.trace.byEvent('auction:bid_accepted').some((event) => (
        (event.payload as { seatId?: string }).seatId === humanA.seatId
      ))
    ).toBe(true);

    const finished = await finishAuctionMatch(run, { maxMs: 180_000 });
    await expectAuctionScenarioInvariants(run, finished);
  }, 210_000);

  it('2H+1B forfeits A on grace expiry, logs the eventual normal finish, and ranks A last', async () => {
    const {
      bootAuctionMatch,
      disconnectAuctionHuman,
      expireAuctionDisconnectGrace,
      finishAuctionMatch,
      waitForHumanTurn,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const { logger } = await import('../../src/core/logger.js');
    const info = vi.spyOn(logger, 'info');

    const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
    const [humanA, humanB] = run.humans;
    await waitForHumanTurn(run, {
      userId: humanA.userId,
      driveSeatIds: [humanB.seatId],
    });
    await disconnectAuctionHuman(run, humanA.userId);
    const outcome = await expireAuctionDisconnectGrace(run, humanA.userId);
    expect(outcome).toEqual(expect.objectContaining({
      kind: 'forfeited',
      userId: humanA.userId,
      reason: 'disconnect_timeout',
    }));

    const finished = await finishAuctionMatch(run, { maxMs: 180_000 });
    const ranking = finished.rankings?.find((entry) => entry.userId === humanA.userId);
    expect(ranking?.rank).toBe(3);
    expect(ranking?.player.forfeited).toBe(true);
    expect(run.trace.byEvent('auction:player_forfeited')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          userId: humanA.userId,
          reason: 'disconnect_timeout',
        }),
      }),
    ]);
    const finishLogs = info.mock.calls.filter((call) => call[1] === 'Auction match finished');
    expect(finishLogs).toHaveLength(1);
    expect(finishLogs[0]?.[0]).toEqual(expect.objectContaining({
      matchId: run.matchId,
      finishReason: 'normal',
    }));
    await expectAuctionScenarioInvariants(run, finished);
  }, 210_000);

  it('2H+1B re-points overlapping graces from resumed A to forfeited B', async () => {
    const {
      bootAuctionMatch,
      disconnectAuctionHuman,
      expireAuctionDisconnectGrace,
      finishAuctionMatch,
      reconnectAuctionHuman,
      waitForHumanTurn,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const {
      getAuctionDisconnectedUser,
      getAuctionPause,
    } = await import(
      '../../src/realtime/services/auction-disconnect-state.service.js'
    );

    const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
    const [humanA, humanB] = run.humans;
    await waitForHumanTurn(run, {
      userId: humanA.userId,
      driveSeatIds: [humanB.seatId],
    });
    await disconnectAuctionHuman(run, humanA.userId);
    await disconnectAuctionHuman(run, humanB.userId);
    const bMarker = await getAuctionDisconnectedUser(run.matchId!, humanB.userId);
    expect(bMarker).toEqual(expect.objectContaining({
      userId: humanB.userId,
      seatId: humanB.seatId,
      disconnectCount: 1,
    }));

    await reconnectAuctionHuman(run, humanA.userId, {
      completeResumeImmediately: true,
    });
    const repointedPause = await getAuctionPause(run.matchId!);
    expect(repointedPause).toEqual(expect.objectContaining({
      userId: humanB.userId,
      seatId: humanB.seatId,
    }));
    expect(repointedPause).toEqual(bMarker);
    const aResume = run.trace.byEvent('auction:resume').at(-1);
    expect(aResume?.target).toBe(`user:${humanA.userId}`);

    const outcome = await expireAuctionDisconnectGrace(run, humanB.userId);
    expect(outcome).toEqual(expect.objectContaining({
      kind: 'forfeited',
      userId: humanB.userId,
    }));
    expect(await getAuctionPause(run.matchId!)).toBeNull();

    const finished = await finishAuctionMatch(run, { maxMs: 180_000 });
    expect(finished.rankings?.at(-1)?.userId).toBe(humanB.userId);
    await expectAuctionScenarioInvariants(run, finished);
  }, 210_000);

  it('voluntary A forfeit leaves B grace intact and B reconnects to finish against the bot', async () => {
    const {
      bootAuctionMatch,
      disconnectAuctionHuman,
      finishAuctionMatch,
      forfeitAuctionHuman,
      reconnectAuctionHuman,
      waitForHumanTurn,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const {
      getAuctionDisconnectedUser,
      getAuctionPause,
    } = await import('../../src/realtime/services/auction-disconnect-state.service.js');

    const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
    const [humanA, humanB] = run.humans;
    await waitForHumanTurn(run, {
      userId: humanB.userId,
      driveSeatIds: [humanA.seatId],
    });
    await disconnectAuctionHuman(run, humanB.userId);
    const bMarker = await getAuctionDisconnectedUser(run.matchId!, humanB.userId);
    expect(bMarker?.disconnectCount).toBe(1);

    await forfeitAuctionHuman(run, humanA.userId);
    expect(await getAuctionDisconnectedUser(run.matchId!, humanB.userId)).toEqual(bMarker);
    expect(await getAuctionPause(run.matchId!)).toEqual(expect.objectContaining({
      userId: humanB.userId,
      seatId: humanB.seatId,
    }));
    expect(
      run.trace.byEvent('auction:player_forfeited').some((event) => (
        (event.payload as { userId?: string }).userId === humanA.userId
      ))
    ).toBe(true);

    await reconnectAuctionHuman(run, humanB.userId);
    const finished = await finishAuctionMatch(run, { maxMs: 180_000 });
    expect(finished.rankings?.at(-1)?.userId).toBe(humanA.userId);
    await expectAuctionScenarioInvariants(run, finished);
  }, 210_000);

  it('3H finishes immediately with the last human standing after two forfeits', async () => {
    const {
      bootAuctionMatch,
      forfeitAuctionHuman,
      getAuctionUserMatchIndexes,
      loadCurrentAuctionState,
      waitUntil,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const { logger } = await import('../../src/core/logger.js');
    const info = vi.spyOn(logger, 'info');

    const run = await bootAuctionMatch({ humanCount: 3, startTimeoutMs: 20_000 });
    await forfeitAuctionHuman(run, run.humans[0].userId);
    await forfeitAuctionHuman(run, run.humans[1].userId);
    const finishedImmediately = await waitUntil(async () => (
      (await loadCurrentAuctionState(run.matchId))?.phase === 'finished'
    ), 1_000);
    expect(finishedImmediately).toBe(true);
    const finished = await loadCurrentAuctionState(run.matchId);
    expect(finished?.rankings?.[0]?.userId).toBe(run.humans[2].userId);
    expect(finished?.rankings?.slice(1).every((entry) => entry.player.forfeited)).toBe(true);
    expect(run.trace.byEvent('auction:match_finished')).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        matchId: run.matchId,
        finishReason: 'last_player_standing',
      }),
      'Auction match finished'
    );
    const {
      checkAuctionInvariants,
      formatAuctionViolation,
    } = await import('../../game-regression/src/auction-invariants.mjs');
    const result = checkAuctionInvariants(run.trace, {
      requireProgress: false,
      userMatchIndexes: await getAuctionUserMatchIndexes(run),
    });
    expect(
      result.ok,
      result.violations.map(formatAuctionViolation).join('\n')
    ).toBe(true);
  }, 30_000);
});

async function expectAuctionScenarioInvariants(
  run: RunAuctionResult,
  state: AuctionMatchState
): Promise<void> {
  const { getAuctionUserMatchIndexes } = await import('../../game-regression/src/auction-runner.mjs');
  const {
    checkAuctionInvariants,
    formatAuctionViolation,
  } = await import('../../game-regression/src/auction-invariants.mjs');
  expect(state.phase).toBe('finished');
  const result = checkAuctionInvariants(run.trace, {
    userMatchIndexes: await getAuctionUserMatchIndexes(run),
  });
  expect(
    result.ok,
    result.violations.map(formatAuctionViolation).join('\n')
  ).toBe(true);
}
