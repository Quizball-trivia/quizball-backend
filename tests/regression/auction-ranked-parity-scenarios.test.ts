import { afterEach, describe, expect, it } from 'vitest';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { AuctionPlayer } from '../../src/modules/auction/auction.types.js';
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

describeLocal('regression: auction ranked-parity lifecycle scenarios', () => {
  afterEach(async () => {
    const { teardownAuctionRun } = await import('../../game-regression/src/auction-runner.mjs');
    await teardownAuctionRun();
  });

  it('ignores an old-tab disconnect while its replacement is present, then counts both tabs dropping once', async () => {
    const {
      bootAuctionMatch,
      disconnectAuctionSocket,
      finishAuctionMatch,
      openAuctionHumanTab,
      reconnectAuctionHuman,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const {
      getAuctionDisconnectCount,
      getAuctionDisconnectedUser,
    } = await import('../../src/realtime/services/auction-disconnect-state.service.js');

    const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
    const human = run.humans[0];
    const oldTab = human.socket;
    const newTab = openAuctionHumanTab(run, human.userId, { makePrimary: true });
    const pausesBefore = run.trace.byEvent('auction:paused').length;

    await disconnectAuctionSocket(run, human.userId, oldTab);
    expect(await getAuctionDisconnectedUser(run.matchId!, human.userId)).toBeNull();
    expect(await getAuctionDisconnectCount(run.matchId!, human.userId)).toBe(0);
    expect(run.trace.byEvent('auction:paused')).toHaveLength(pausesBefore);

    const dropped = await disconnectAuctionSocket(run, human.userId, newTab);
    expect(dropped.marker?.disconnectCount).toBe(1);
    expect(await getAuctionDisconnectCount(run.matchId!, human.userId)).toBe(1);
    await reconnectAuctionHuman(run, human.userId, { completeResumeImmediately: true });

    const finished = await finishAuctionMatch(run, { maxMs: 180_000 });
    await expectAuctionScenarioInvariants(run, finished);
  }, 210_000);

  it('deduplicates stale debounce delivery during a rapid flap and limits only distinct drops', async () => {
    const {
      bootAuctionMatch,
      disconnectAuctionHuman,
      finishAuctionMatch,
      reconnectAuctionHuman,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const {
      getAuctionDisconnectCount,
      getAuctionDisconnectedUser,
    } = await import('../../src/realtime/services/auction-disconnect-state.service.js');
    const { runAuctionDisconnectDebounceTimer } = await import(
      '../../src/realtime/services/auction-disconnect.service.js'
    );

    const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
    const human = run.humans[0];
    await disconnectAuctionHuman(run, human.userId);
    expect(await getAuctionDisconnectCount(run.matchId!, human.userId)).toBe(1);
    await reconnectAuctionHuman(run, human.userId, { completeResumeImmediately: true });

    await disconnectAuctionHuman(run, human.userId, { runDebounce: false });
    const marker = await getAuctionDisconnectedUser(run.matchId!, human.userId);
    expect(marker?.disconnectCount).toBe(0);
    const stalePayload = {
      kind: 'auction_disconnect_debounce' as const,
      matchId: run.matchId!,
      userId: human.userId,
      seatId: human.seatId,
      disconnectedAt: new Date().toISOString(),
    };
    await runAuctionDisconnectDebounceTimer(run.io as never, stalePayload);
    await runAuctionDisconnectDebounceTimer(run.io as never, stalePayload);
    expect(await getAuctionDisconnectCount(run.matchId!, human.userId)).toBe(2);
    expect(run.trace.byEvent('auction:player_forfeited')).toHaveLength(0);
    await reconnectAuctionHuman(run, human.userId, { completeResumeImmediately: true });

    await disconnectAuctionHuman(run, human.userId);
    expect(await getAuctionDisconnectCount(run.matchId!, human.userId)).toBe(3);
    expect(run.trace.byEvent('auction:player_forfeited')).toHaveLength(0);
    await reconnectAuctionHuman(run, human.userId, { completeResumeImmediately: true });
    await disconnectAuctionHuman(run, human.userId);
    expect(await getAuctionDisconnectCount(run.matchId!, human.userId)).toBe(4);
    expect(run.trace.byEvent('auction:player_forfeited')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          userId: human.userId,
          reason: 'reconnect_limit',
        }),
      }),
    ]);

    const finished = await finishAuctionMatch(run, { maxMs: 180_000 });
    await expectAuctionScenarioInvariants(run, finished);
  }, 210_000);

  it('arms grace for a never-connected matched human and forfeits them at expiry', async () => {
    const {
      bootAuctionMatch,
      expireAuctionDisconnectGrace,
      finishAuctionMatch,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const {
      getAuctionDisconnectCount,
      getAuctionDisconnectedUser,
    } = await import('../../src/realtime/services/auction-disconnect-state.service.js');

    const absentUserId = '00000000-0000-0000-0000-00000000a001';
    const run = await bootAuctionMatch({
      humanCount: 2,
      absentHumanUserIds: [absentUserId],
      startTimeoutMs: 20_000,
    });
    const absent = run.humans.find((human) => human.userId === absentUserId)!;
    expect(await getAuctionDisconnectedUser(run.matchId!, absent.userId)).toEqual(
      expect.objectContaining({
        userId: absent.userId,
        seatId: absent.seatId,
        disconnectCount: 1,
      })
    );
    expect(await getAuctionDisconnectCount(run.matchId!, absent.userId)).toBe(1);

    const outcome = await expireAuctionDisconnectGrace(run, absent.userId);
    expect(outcome).toEqual(expect.objectContaining({
      kind: 'forfeited',
      userId: absent.userId,
      reason: 'disconnect_timeout',
    }));
    const finished = await finishAuctionMatch(run, { maxMs: 180_000 });
    expect(finished.rankings?.at(-1)?.userId).toBe(absent.userId);
    await expectAuctionScenarioInvariants(run, finished);
  }, 210_000);

  it('finishes and persists once when a socket drops in the final-resolution window', async () => {
    const {
      bootAuctionMatch,
      disconnectAuctionSocket,
      loadCurrentAuctionState,
      waitUntil,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const { auctionStateStore, saveAuctionMatchMutation } = await import(
      '../../src/modules/auction/auction-state.store.js'
    );
    const { advanceAuctionMatchFlowFromRevealGate } = await import(
      '../../src/realtime/services/auction-match-flow.service.js'
    );
    const { matchesRepo } = await import('../../src/modules/matches/matches.repo.js');
    const { matchPlayersRepo } = await import('../../src/modules/matches/match-players.repo.js');

    const run = await bootAuctionMatch({ humanCount: 2, startTimeoutMs: 20_000 });
    const staged = await auctionStateStore.mutate(run.matchId!, (current) => {
      if (!current.currentRound) throw new Error('Auction round missing for finish-window staging');
      const footballer = current.currentRound.footballer;
      const seats = current.seats.map((seat) => completeSeat(seat, footballer));
      return saveAuctionMatchMutation({
        ...current,
        phase: 'reveal',
        seats,
        currentRound: {
          ...current.currentRound,
          winnerSeatId: run.humans[0].seatId,
          winningBid: 0,
          revealed: true,
        },
      }, (next) => next);
    });

    const finishing = advanceAuctionMatchFlowFromRevealGate(run.io as never, staged, {});
    const savedFinished = await waitUntil(async () => (
      (await loadCurrentAuctionState(run.matchId))?.phase === 'finished'
    ), 5_000);
    expect(savedFinished).toBe(true);
    await disconnectAuctionSocket(run, run.humans[0].userId, run.humans[0].socket);
    await finishing;

    const finished = await loadCurrentAuctionState(run.matchId);
    expect(finished?.phase).toBe('finished');
    expect(run.trace.byEvent('auction:match_finished')).toHaveLength(1);
    expect((await matchesRepo.getMatch(run.matchId!))?.status).toBe('completed');
    expect(await matchPlayersRepo.listMatchPlayers(run.matchId!)).toHaveLength(3);
    await expectAuctionScenarioInvariants(run, finished!, false);
  }, 30_000);

  it('resolves cancel versus match-start as either clean cancellation or seated rejection', async () => {
    const {
      bootAuctionMatch,
      forfeitAuctionHuman,
      getAuctionUserMatchIndexes,
    } = await import('../../game-regression/src/auction-runner.mjs');
    const { auctionMatchmakingService } = await import(
      '../../src/realtime/services/auction-matchmaking.service.js'
    );
    const { auctionStateStore } = await import('../../src/modules/auction/auction-state.store.js');
    const { getRedisClient } = await import('../../src/realtime/redis.js');

    const run = await bootAuctionMatch({ humanCount: 3, startTimeoutMs: 20_000 });
    await forfeitAuctionHuman(run, run.humans[0].userId);
    await forfeitAuctionHuman(run, run.humans[1].userId);
    expect((await auctionStateStore.load(run.matchId!))?.phase).toBe('finished');
    expect(Object.values(await getAuctionUserMatchIndexes(run)).every((value) => value === null)).toBe(true);
    run.trace.reset();

    const [humanA, humanB, humanC] = run.humans;
    await auctionMatchmakingService.handleSearchStart(run.io as never, humanA.socket as never, { locale: 'en' });
    await auctionMatchmakingService.handleSearchStart(run.io as never, humanB.socket as never, { locale: 'en' });
    await Promise.all([
      auctionMatchmakingService.handleSearchStart(run.io as never, humanC.socket as never, { locale: 'en' }),
      auctionMatchmakingService.handleSearchCancel(run.io as never, humanA.socket as never),
    ]);

    const matchFound = run.trace.byEvent('auction:match_found').at(-1);
    const cancelled = run.trace.byEvent('auction:search_cancelled', humanA.socket.id).at(-1);
    const rejected = run.trace.byEvent('auction:error', humanA.socket.id).at(-1);
    const activeMatchId = await auctionStateStore.getActiveMatchIdForUser(humanA.userId);
    if (matchFound) {
      expect(activeMatchId).toBe((matchFound.payload as { matchId: string }).matchId);
      expect(cancelled).toBeUndefined();
      expect(rejected?.payload).toEqual(expect.objectContaining({
        code: expect.stringMatching(/^auction_search_cancel_(?:busy|rejected)$/),
      }));
      const state = await auctionStateStore.load(activeMatchId!);
      expect(state?.seats.some((seat) => seat.userId === humanA.userId)).toBe(true);
      run.matchId = activeMatchId;
      for (const human of run.humans) {
        human.seatId = state!.seats.find((seat) => seat.userId === human.userId)!.seatId;
      }
      await forfeitAuctionHuman(run, humanB.userId);
      await forfeitAuctionHuman(run, humanC.userId);
      const finished = await auctionStateStore.load(activeMatchId!);
      expect(finished?.phase).toBe('finished');
      expect(Object.values(await getAuctionUserMatchIndexes(run)).every((value) => value === null)).toBe(true);
      await expectAuctionScenarioInvariants(run, finished!, false);
    } else {
      expect(cancelled?.payload).toEqual(expect.objectContaining({
        searchId: expect.any(String),
        reason: 'cancelled',
      }));
      expect(activeMatchId).toBeNull();
      const redis = getRedisClient();
      expect(await redis?.hGet('auction:mm:user', humanA.userId)).toBeNull();
      await auctionMatchmakingService.handleSearchCancel(run.io as never, humanB.socket as never);
      await auctionMatchmakingService.handleSearchCancel(run.io as never, humanC.socket as never);
      expect(Object.values(await getAuctionUserMatchIndexes(run)).every((value) => value === null)).toBe(true);
    }
  }, 30_000);
});

function completeSeat(
  seat: AuctionPlayer,
  footballer: NonNullable<AuctionMatchState['currentRound']>['footballer']
): AuctionPlayer {
  const required = seat.team.formation.required;
  return {
    ...seat,
    team: {
      ...seat.team,
      slots: {
        GK: Array.from({ length: required.GK }, () => ({
          ...footballer,
          positionGroup: 'GK' as const,
          trueValue: 1_000_000,
        })),
        DEF: Array.from({ length: required.DEF }, () => ({
          ...footballer,
          positionGroup: 'DEF' as const,
          trueValue: 1_000_000,
        })),
        MID: Array.from({ length: required.MID }, () => ({
          ...footballer,
          positionGroup: 'MID' as const,
          trueValue: 1_000_000,
        })),
        FWD: Array.from({ length: required.FWD }, () => ({
          ...footballer,
          positionGroup: 'FWD' as const,
          trueValue: 1_000_000,
        })),
      },
    },
  };
}

async function expectAuctionScenarioInvariants(
  run: RunAuctionResult,
  state: AuctionMatchState,
  requireProgress = true
): Promise<void> {
  const { getAuctionUserMatchIndexes } = await import('../../game-regression/src/auction-runner.mjs');
  const {
    checkAuctionInvariants,
    formatAuctionViolation,
  } = await import('../../game-regression/src/auction-invariants.mjs');
  expect(state.phase).toBe('finished');
  const result = checkAuctionInvariants(run.trace, {
    requireProgress,
    userMatchIndexes: await getAuctionUserMatchIndexes(run),
  });
  expect(
    result.ok,
    result.violations.map(formatAuctionViolation).join('\n')
  ).toBe(true);
}
