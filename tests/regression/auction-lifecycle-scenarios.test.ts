import { afterEach, describe, expect, it } from 'vitest';
import type { AuctionMatchState, AuctionMatchPhase } from '../../src/modules/auction/auction-match-state.js';
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

describeLocal('regression: auction lifecycle, concurrency, and restart scenarios', () => {
  afterEach(async () => {
    const { teardownAuctionRun } = await import('../../game-regression/src/auction-runner.mjs');
    await teardownAuctionRun();
  });

  it('swaps both human sockets at match entry inside debounce without visible pause/resume', async () => {
    const {
      bootAuctionMatch,
      finishAuctionMatch,
      swapAuctionHumanSocket,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const { getAuctionDisconnectCount } = await import(
      '../../src/realtime/services/auction-disconnect-state.service.js'
    );

    const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
    await Promise.all(run.humans.map((human) => (
      swapAuctionHumanSocket(run, human.userId)
    )));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(run.trace.byEvent('auction:paused')).toHaveLength(0);
    expect(run.trace.byEvent('auction:resume')).toHaveLength(0);
    expect(run.trace.byEvent('auction:resume_countdown')).toHaveLength(0);
    for (const human of run.humans) {
      expect(await getAuctionDisconnectCount(run.matchId!, human.userId)).toBe(0);
    }

    const finished = await finishAuctionMatch(run, { maxMs: 180_000 });
    await expectAuctionScenarioInvariants(run, finished);
  }, 210_000);

  it('forfeits A via reconnect_limit after the fourth counted flap', async () => {
    const {
      bootAuctionMatch,
      disconnectAuctionHuman,
      finishAuctionMatch,
      reconnectAuctionHuman,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const { getAuctionDisconnectCount } = await import(
      '../../src/realtime/services/auction-disconnect-state.service.js'
    );

    const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
    const humanA = run.humans[0];
    for (let flap = 1; flap <= 3; flap += 1) {
      const disconnected = await disconnectAuctionHuman(run, humanA.userId);
      expect(disconnected.marker?.disconnectCount).toBe(flap);
      await reconnectAuctionHuman(run, humanA.userId);
      expect(await getAuctionDisconnectCount(run.matchId!, humanA.userId)).toBe(flap);
    }

    await disconnectAuctionHuman(run, humanA.userId);
    expect(await getAuctionDisconnectCount(run.matchId!, humanA.userId)).toBe(4);
    const forfeit = run.trace.byEvent('auction:player_forfeited').find((event) => (
      (event.payload as { userId?: string }).userId === humanA.userId
    ));
    expect(forfeit?.payload).toEqual(expect.objectContaining({
      userId: humanA.userId,
      seatId: humanA.seatId,
      reason: 'reconnect_limit',
    }));

    const finished = await finishAuctionMatch(run, { maxMs: 180_000 });
    expect(finished.rankings?.at(-1)?.userId).toBe(humanA.userId);
    await expectAuctionScenarioInvariants(run, finished);
  }, 210_000);

  it('presence guard preserves A at reconnect_limit when a live match socket exists', async () => {
    const {
      bootAuctionMatch,
      finishAuctionMatch,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const {
      getAuctionDisconnectCount,
      incrementAuctionDisconnectCount,
      markAuctionUserDisconnected,
    } = await import('../../src/realtime/services/auction-disconnect-state.service.js');
    const { runAuctionDisconnectGraceTimer } = await import(
      '../../src/realtime/services/auction-disconnect.service.js'
    );

    const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
    const humanA = run.humans[0];
    for (let count = 0; count < 4; count += 1) {
      await incrementAuctionDisconnectCount(run.matchId!, humanA.userId);
    }
    const pauseUntil = new Date(Date.now() + 5_000).toISOString();
    await markAuctionUserDisconnected({
      matchId: run.matchId!,
      userId: humanA.userId,
      seatId: humanA.seatId,
      pauseUntil,
      disconnectCount: 4,
    });

    const live = run.io.createSocket('auction-presence-guard-live-a', {
      user: { id: humanA.userId, nickname: humanA.displayName },
      matchId: run.matchId!,
      connectedAt: Date.now(),
    });
    live.join(`user:${humanA.userId}`);
    live.join(`match:${run.matchId}`);
    humanA.socket = live;

    const outcome = await runAuctionDisconnectGraceTimer(run.io as never, {
      kind: 'auction_disconnect_grace',
      matchId: run.matchId!,
      userId: humanA.userId,
      seatId: humanA.seatId,
      disconnectCount: 4,
    }, {}, 'reconnect_limit');
    expect(outcome).toEqual({ kind: 'noop', reason: 'replacement_socket_present' });
    expect(await getAuctionDisconnectCount(run.matchId!, humanA.userId)).toBe(4);
    expect(
      run.trace.byEvent('auction:player_forfeited').some((event) => (
        (event.payload as { userId?: string }).userId === humanA.userId
      ))
    ).toBe(false);

    const finished = await finishAuctionMatch(run, { maxMs: 180_000 });
    await expectAuctionScenarioInvariants(run, finished);
  }, 210_000);

  for (const phase of ['solo_pick', 'reveal'] as const) {
    it(`disconnects during ${phase}, defers phase timers, resumes, and advances`, async () => {
      const {
        bootAuctionMatch,
        disconnectAuctionHuman,
        finishAuctionMatch,
        loadCurrentAuctionState,
        reconnectAuctionHuman,
        stageAuctionRevealForHuman,
        stageAuctionSoloPickForHuman,
        waitForAuctionState,
      } = await import('../../game-regression/src/auction-runner.mjs');

      const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
      const target = run.humans[0];
      const reached = phase === 'solo_pick'
        ? await stageAuctionSoloPickForHuman(run, target.userId)
        : await stageAuctionRevealForHuman(run, target.userId);
      expect(reached?.phase).toBe(phase);
      const targetSeatId = phase === 'solo_pick'
        ? reached!.soloPick!.playerSeatId
        : target.seatId;
      const human = run.humans.find((entry) => entry.seatId === targetSeatId);
      expect(human, `${phase} target should be a human seat`).toBeTruthy();

      const phaseVersion = reached!.version;
      await disconnectAuctionHuman(run, human!.userId);
      await new Promise((resolve) => setTimeout(resolve, 75));
      const paused = await loadCurrentAuctionState(run.matchId);
      expect(paused?.phase).toBe(phase);
      expect(paused?.version).toBe(phaseVersion);

      await reconnectAuctionHuman(run, human!.userId);
      const advanced = await waitForAuctionState(
        run,
        (state) => state.phase !== phase,
        { maxMs: 30_000 }
      );
      expect(advanced?.phase).not.toBe(phase);

      const finished = advanced?.phase === 'finished'
        ? advanced
        : await finishAuctionMatch(run, { maxMs: 180_000 });
      await expectAuctionScenarioInvariants(run, finished!);
    }, 210_000);
  }

  it('serializes simultaneous same-snapshot human bids into one accept and one clean reject', async () => {
    const {
      bootAuctionMatch,
      finishAuctionMatch,
      loadCurrentAuctionState,
      waitForHumanTurn,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const { getMinBid } = await import('../../src/modules/auction/auction-rules.js');
    const { handleAuctionBid } = await import('../../src/realtime/services/auction-turn.service.js');

    const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
    const turn = await waitForHumanTurn(run, { driveSeatIds: [] });
    const current = turn.human;
    const contender = run.humans.find((human) => human.userId !== current.userId)!;
    const snapshotVersion = turn.state.version;
    const amount = getMinBid(
      turn.state.currentRound!.startingPrice,
      turn.state.currentRound!.highestBid
    );
    const acceptedBefore = run.trace.byEvent('auction:bid_accepted').length;
    const errorsBefore = run.trace.byEvent('auction:error').length;

    const outcomes = await Promise.all([
      handleAuctionBid(run.io as never, current.socket as never, {
        matchId: run.matchId!,
        amount,
      }),
      handleAuctionBid(run.io as never, contender.socket as never, {
        matchId: run.matchId!,
        amount,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome?.kind === 'bid_accepted')).toHaveLength(1);
    expect(run.trace.byEvent('auction:bid_accepted').length - acceptedBefore).toBe(1);
    expect(run.trace.byEvent('auction:error').length - errorsBefore).toBe(1);
    const rejected = run.trace.byEvent('auction:error').slice(errorsBefore)[0];
    expect((rejected.payload as { code?: string }).code).toMatch(
      /^auction_(?:not_current_turn|invalid_action)$/
    );
    expect(
      run.trace.byEvent('auction:error').slice(errorsBefore).some((event) => (
        JSON.stringify(event.payload).includes('AuctionMatchLockUnavailableError')
        || JSON.stringify(event.payload).toLowerCase().includes('auction match lock unavailable')
      ))
    ).toBe(false);

    const after = await loadCurrentAuctionState(run.matchId);
    expect(after!.version).toBe(snapshotVersion + 1);
    expect(after!.currentRound!.bids.filter((bid) => bid.amount === amount)).toHaveLength(1);

    const finished = await finishAuctionMatch(run, { maxMs: 180_000 });
    await expectAuctionScenarioInvariants(run, finished);
  }, 210_000);

  for (const restartPhase of ['round', 'bidding', 'reveal'] as const) {
    it(`self-heals and finishes after process restart during ${restartPhase}`, async () => {
      const {
        bootAuctionMatch,
        finishAuctionMatch,
        restartAuctionProcess,
        waitForAuctionState,
      } = await import('../../game-regression/src/auction-runner.mjs');

      const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
      if (restartPhase !== 'round') {
        const target: AuctionMatchPhase = restartPhase;
        const reached = await waitForAuctionState(
          run,
          (state) => state.phase === target,
          { maxMs: 180_000 }
        );
        expect(reached?.phase).toBe(target);
      } else {
        expect(
          run.trace.byEvent('auction:waiting_for_ready').some((event) => (
            (event.payload as { phase?: string }).phase === 'round'
          ))
        ).toBe(true);
      }

      const summary = await restartAuctionProcess(run);
      expect(summary.scanned).toBeGreaterThanOrEqual(1);
      expect(summary.rearmed).toBeGreaterThanOrEqual(1);
      expect(summary.failed).toBe(0);

      const finished = await finishAuctionMatch(run, { maxMs: 180_000 });
      await expectAuctionScenarioInvariants(run, finished);
    }, 210_000);
  }
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
