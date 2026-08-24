import { FakeIo, createTrace, type EventTrace, type FakeSocket, type TraceEvent } from './adapter.mjs';
import {
  seedAuctionFixtures,
  seedTestUserWithTicket,
  type SeededAuctionFixtures,
} from './fixtures.mjs';

import { disconnectDb } from '../../src/db/index.js';
import {
  resolveRoundWin,
  startSoloPick,
} from '../../src/modules/auction/auction-engine.js';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import {
  auctionStateStore,
  saveAuctionMatchMutation,
} from '../../src/modules/auction/auction-state.store.js';
import type { FormationName } from '../../src/modules/auction/auction.types.js';
import {
  cancelRealtimeTimer,
  startRealtimeTimerScheduler,
  stopRealtimeTimerScheduler,
} from '../../src/realtime/realtime-timer-scheduler.js';
import { closeRedisClients, getRedisClient, initRedisClients } from '../../src/realtime/redis.js';
import { buildRealtimeTimerHandlers } from '../../src/realtime/socket-server.js';
import {
  handleAuctionForfeit,
  handleAuctionRejoin,
  handleAuctionSocketDisconnect,
  auctionResumeCountdownTimerKey,
  runAuctionDisconnectDebounceTimer,
  runAuctionDisconnectGraceTimer,
  runAuctionResumeCountdownTimer,
} from '../../src/realtime/services/auction-disconnect.service.js';
import {
  getAuctionDisconnectedUser,
  type AuctionDisconnectPause,
} from '../../src/realtime/services/auction-disconnect-state.service.js';
import { auctionLifecycleService } from '../../src/realtime/services/auction-lifecycle.service.js';
import { advanceAuctionMatchFlowAfterMutation } from '../../src/realtime/services/auction-match-flow.service.js';
import {
  rejoinAuctionMatch,
  startAuctionMatchForHumans,
  type AuctionMatchHumanPlayer,
} from '../../src/realtime/services/auction-realtime.service.js';
import {
  handleAuctionBid,
  handleAuctionFold,
  handleAuctionSoloPickSelect,
} from '../../src/realtime/services/auction-turn.service.js';
import { clearAuctionUiReadyGate } from '../../src/realtime/services/auction-ui-ready.service.js';

const AUCTION_USER_IDS = [
  '00000000-0000-0000-0000-00000000a001',
  '00000000-0000-0000-0000-00000000a002',
  '00000000-0000-0000-0000-00000000a003',
] as const;

export interface AuctionHarnessHuman {
  userId: string;
  displayName: string;
  seatId: string;
  socket: FakeSocket;
  socketGeneration: number;
}

export interface RunAuctionResult {
  trace: EventTrace;
  fixtures: SeededAuctionFixtures;
  humans: AuctionHarnessHuman[];
  userId: string;
  matchId: string | null;
  humanSeatId: string | null;
  io: FakeIo;
  socket: FakeSocket;
  handledTurns: Set<string>;
  handledSoloPicks: Set<string>;
}

export interface RunAuctionOptions {
  userId?: string;
  humanCount?: 1 | 2 | 3;
  humanPlayers?: readonly AuctionMatchHumanPlayer[];
  absentHumanUserIds?: readonly string[];
  formation?: FormationName;
  locale?: 'en' | 'ka';
  startTimeoutMs?: number;
  playMaxMs?: number;
  playTickMs?: number;
}

export interface PlayAuctionOptions {
  maxMs?: number;
  tickMs?: number;
  actionSeatIds?: readonly string[];
  until?: (state: AuctionMatchState) => boolean;
}

export interface TeardownAuctionRunOptions {
  closeClients?: boolean;
}

export interface AuctionDisconnectResult {
  marker: AuctionDisconnectPause | null;
  pauseEventsBefore: number;
}

const activeRuns = new Set<RunAuctionResult>();

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  maxMs: number,
  stepMs = 10
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  if (await predicate()) return true;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    if (await predicate()) return true;
  }
  return false;
}

export async function bootAuctionMatch(options: RunAuctionOptions = {}): Promise<RunAuctionResult> {
  const locale = options.locale ?? 'en';
  const humanPlayers = resolveHumanPlayers(options);
  const trace = createTrace(() => Date.now());
  const io = new FakeIo(trace);

  const fixtures = await seedAuctionFixtures();
  await Promise.all(humanPlayers.map((player, index) => (
    seedTestUserWithTicket({
      userId: player.userId,
      nickname: player.displayName || `AuctionHarnessHuman${index + 1}`,
      tickets: 0,
    })
  )));

  await initRedisClients();
  const redisForFlush = getRedisClient();
  if (redisForFlush?.isOpen) await redisForFlush.flushDb();
  startRealtimeTimerScheduler(io as never, buildRealtimeTimerHandlers());

  const sockets = humanPlayers.map((player, index) => {
    const socket = io.createSocket(`auction-harness-${index + 1}-socket-1`, {
      user: { id: player.userId, nickname: player.displayName },
      connectedAt: Date.now(),
    });
    if (!options.absentHumanUserIds?.includes(player.userId)) {
      socket.join(`user:${player.userId}`);
    }
    return socket;
  });

  const saved = await startAuctionMatchForHumans(io as never, {
    humanPlayers,
    formation: options.formation,
    locale,
  });
  for (const userId of options.absentHumanUserIds ?? []) {
    const seat = saved.seats.find((entry) => entry.userId === userId);
    const disconnected = await getAuctionDisconnectedUser(saved.matchId, userId);
    if (!seat || !disconnected) continue;
    await runAuctionDisconnectDebounceTimer(io as never, {
      kind: 'auction_disconnect_debounce',
      matchId: saved.matchId,
      userId,
      seatId: seat.seatId,
      disconnectedAt: new Date().toISOString(),
    });
  }

  const started = await waitUntil(
    () => (
      trace.byEvent('auction:match_started').length > 0
      && trace.byEvent('auction:round_started').length > 0
    ),
    options.startTimeoutMs ?? 10_000
  );
  const matchId = started ? saved.matchId : null;
  const humans = humanPlayers.map((player, index) => {
    const seat = saved.seats.find((entry) => !entry.isBot && entry.userId === player.userId);
    if (!seat) throw new Error(`Auction harness human seat missing for ${player.userId}`);
    return {
      userId: player.userId,
      displayName: player.displayName,
      seatId: seat.seatId,
      socket: sockets[index],
      socketGeneration: 1,
    };
  });
  const primary = humans[0];
  const run: RunAuctionResult = {
    trace,
    fixtures,
    humans,
    userId: primary.userId,
    matchId,
    humanSeatId: primary.seatId,
    io,
    socket: primary.socket,
    handledTurns: new Set(),
    handledSoloPicks: new Set(),
  };
  activeRuns.add(run);
  return run;
}

export async function playAuctionMatch(
  run: RunAuctionResult,
  options: PlayAuctionOptions = {}
): Promise<AuctionMatchState | null> {
  const maxMs = options.maxMs ?? 120_000;
  const tickMs = options.tickMs ?? 10;
  const deadline = Date.now() + maxMs;
  const actionSeatIds = options.actionSeatIds
    ? new Set(options.actionSeatIds)
    : new Set(run.humans.map((human) => human.seatId));

  while (Date.now() < deadline) {
    const before = await loadCurrentAuctionState(run.matchId);
    if (!before) return null;
    if (options.until?.(before) || before.phase === 'finished') return before;

    await driveHumanAuctionActions(run, actionSeatIds);

    const after = await loadCurrentAuctionState(run.matchId);
    if (!after) return null;
    if (options.until?.(after) || after.phase === 'finished') return after;
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }

  return loadCurrentAuctionState(run.matchId);
}

export async function runFullAuctionMatch(options: RunAuctionOptions = {}): Promise<RunAuctionResult> {
  const run = await bootAuctionMatch(options);
  if (run.matchId) {
    await playAuctionMatch(run, {
      maxMs: options.playMaxMs,
      tickMs: options.playTickMs,
    });
  }
  return run;
}

export async function finishAuctionMatch(
  run: RunAuctionResult,
  options: PlayAuctionOptions = {}
): Promise<AuctionMatchState> {
  const state = await playAuctionMatch(run, options);
  if (!state || state.phase !== 'finished') {
    throw new Error(`Auction match ${run.matchId ?? 'missing'} did not finish; phase=${state?.phase ?? 'missing'}`);
  }
  const emitted = await waitUntil(
    () => run.trace.byEvent('auction:match_finished').length > 0,
    5_000
  );
  if (!emitted) throw new Error(`Auction match ${state.matchId} finished without auction:match_finished`);
  return state;
}

export async function waitForAuctionState(
  run: RunAuctionResult,
  predicate: (state: AuctionMatchState) => boolean,
  options: PlayAuctionOptions = {}
): Promise<AuctionMatchState | null> {
  return playAuctionMatch(run, {
    ...options,
    until: predicate,
  });
}

export async function waitForAuctionEvent(
  run: RunAuctionResult,
  event: string,
  options: {
    afterSeq?: number;
    maxMs?: number;
    predicate?: (traceEvent: TraceEvent) => boolean;
  } = {}
): Promise<TraceEvent | null> {
  let found: TraceEvent | undefined;
  const ok = await waitUntil(() => {
    found = run.trace.byEvent(event).find((entry) => (
      entry.seq > (options.afterSeq ?? -1)
      && (options.predicate?.(entry) ?? true)
    ));
    return Boolean(found);
  }, options.maxMs ?? 5_000);
  return ok ? found ?? null : null;
}

export async function waitForHumanTurn(
  run: RunAuctionResult,
  options: { userId?: string; maxMs?: number; driveSeatIds?: readonly string[] } = {}
): Promise<{ state: AuctionMatchState; human: AuctionHarnessHuman }> {
  let selected: AuctionHarnessHuman | null = null;
  const state = await waitForAuctionState(run, (current) => {
    const seatId = current.currentRound?.currentTurnSeatId;
    selected = run.humans.find((human) => (
      human.seatId === seatId
      && (!options.userId || human.userId === options.userId)
    )) ?? null;
    return current.phase === 'bidding' && Boolean(selected);
  }, {
    maxMs: options.maxMs ?? 30_000,
    actionSeatIds: options.driveSeatIds ?? [],
  });
  if (!state || !selected) throw new Error('Timed out waiting for an Auction human turn');
  return { state, human: selected };
}

export async function disconnectAuctionHuman(
  run: RunAuctionResult,
  userId: string,
  options: { runDebounce?: boolean } = {}
): Promise<AuctionDisconnectResult> {
  const human = requireAuctionHuman(run, userId);
  return disconnectAuctionSocket(run, userId, human.socket, options);
}

export async function disconnectAuctionSocket(
  run: RunAuctionResult,
  userId: string,
  socket: FakeSocket,
  options: { runDebounce?: boolean } = {}
): Promise<AuctionDisconnectResult> {
  const human = requireAuctionHuman(run, userId);
  const pauseEventsBefore = run.trace.byEvent('auction:paused').length;
  run.io.removeSocket(socket);
  await handleAuctionSocketDisconnect(run.io as never, socket as never);

  if (options.runDebounce !== false && run.matchId) {
    const provisional = await getAuctionDisconnectedUser(run.matchId, userId);
    if (provisional) {
      await runAuctionDisconnectDebounceTimer(run.io as never, {
        kind: 'auction_disconnect_debounce',
        matchId: run.matchId,
        userId,
        seatId: human.seatId,
        disconnectedAt: new Date().toISOString(),
      });
    }
  }

  return {
    marker: run.matchId ? await getAuctionDisconnectedUser(run.matchId, userId) : null,
    pauseEventsBefore,
  };
}

export function openAuctionHumanTab(
  run: RunAuctionResult,
  userId: string,
  options: { makePrimary?: boolean } = {}
): FakeSocket {
  if (!run.matchId) throw new Error('Auction match has not started');
  const human = requireAuctionHuman(run, userId);
  const socket = createReplacementSocket(run, human);
  socket.data.matchId = run.matchId;
  socket.join(`match:${run.matchId}`);
  if (options.makePrimary) {
    human.socket = socket;
    if (run.userId === userId) run.socket = socket;
  }
  return socket;
}

export async function reconnectAuctionHuman(
  run: RunAuctionResult,
  userId: string,
  options: {
    waitForResume?: boolean;
    completeResumeImmediately?: boolean;
  } = {}
): Promise<FakeSocket> {
  if (!run.matchId) throw new Error('Auction match has not started');
  const human = requireAuctionHuman(run, userId);
  const resumeEventsBefore = run.trace.byEvent('auction:resume').length;
  const socket = createReplacementSocket(run, human);

  await auctionLifecycleService.rejoinActiveAuctionMatchOnConnect(run.io as never, socket as never);
  const rejoined = await handleAuctionRejoin(run.io as never, socket as never, run.matchId);
  if (!rejoined) throw new Error(`Auction rejoin rejected for ${userId}`);

  human.socket = socket;
  if (run.userId === userId) run.socket = socket;

  if (options.completeResumeImmediately) {
    await cancelRealtimeTimer(
      'auction_resume_countdown',
      auctionResumeCountdownTimerKey(run.matchId, userId)
    );
    await runAuctionResumeCountdownTimer(run.io as never, {
      kind: 'auction_resume_countdown',
      matchId: run.matchId,
      userId,
    });
  }

  if (options.waitForResume !== false) {
    const resumed = await waitUntil(
      () => run.trace.byEvent('auction:resume').length > resumeEventsBefore,
      5_000
    );
    if (!resumed) throw new Error(`Auction resume did not fire for ${userId}`);
  }
  return socket;
}

export async function stageAuctionSoloPickForHuman(
  run: RunAuctionResult,
  userId: string
): Promise<AuctionMatchState> {
  if (!run.matchId) throw new Error('Auction match has not started');
  const human = requireAuctionHuman(run, userId);
  const saved = await auctionStateStore.mutate(run.matchId, (current) => {
    const footballer = current.currentRound?.footballer;
    if (!footballer) throw new Error('Auction round footballer missing for solo-pick staging');
    return saveAuctionMatchMutation(
      startSoloPick(
        current,
        human.seatId,
        footballer.positionGroup,
        footballer,
        footballer
      ),
      (next) => next
    );
  });
  await advanceAuctionMatchFlowAfterMutation(run.io as never, saved);
  return saved;
}

export async function stageAuctionRevealForHuman(
  run: RunAuctionResult,
  userId: string
): Promise<AuctionMatchState> {
  if (!run.matchId) throw new Error('Auction match has not started');
  const human = requireAuctionHuman(run, userId);
  return auctionStateStore.mutate(run.matchId, (current) => {
    const round = current.currentRound;
    if (!round) throw new Error('Auction round missing for reveal staging');
    const amount = round.startingPrice;
    const staged = {
      ...current,
      phase: 'bidding' as const,
      currentRound: {
        ...round,
        bids: [{
          seatId: human.seatId,
          amount,
          placedAt: new Date().toISOString(),
        }],
        highestBidderSeatId: human.seatId,
        highestBid: amount,
      },
    };
    return saveAuctionMatchMutation(resolveRoundWin(staged), (next) => next);
  });
}

export async function swapAuctionHumanSocket(
  run: RunAuctionResult,
  userId: string
): Promise<FakeSocket> {
  if (!run.matchId) throw new Error('Auction match has not started');
  const human = requireAuctionHuman(run, userId);
  run.io.removeSocket(human.socket);
  await handleAuctionSocketDisconnect(run.io as never, human.socket as never);
  const socket = createReplacementSocket(run, human);
  const rejoined = await rejoinAuctionMatch(run.io as never, socket as never, run.matchId);
  if (!rejoined) throw new Error(`Auction socket swap rejected for ${userId}`);
  human.socket = socket;
  if (run.userId === userId) run.socket = socket;
  return socket;
}

export async function expireAuctionDisconnectGrace(
  run: RunAuctionResult,
  userId: string,
  reason: 'disconnect_timeout' | 'reconnect_limit' = 'disconnect_timeout'
) {
  if (!run.matchId) throw new Error('Auction match has not started');
  const human = requireAuctionHuman(run, userId);
  const marker = await getAuctionDisconnectedUser(run.matchId, userId);
  if (!marker) throw new Error(`Auction disconnect marker missing for ${userId}`);
  return runAuctionDisconnectGraceTimer(run.io as never, {
    kind: 'auction_disconnect_grace',
    matchId: run.matchId,
    userId,
    seatId: human.seatId,
    disconnectCount: marker.disconnectCount,
  }, {}, reason);
}

export async function forfeitAuctionHuman(
  run: RunAuctionResult,
  userId: string
): Promise<void> {
  const human = requireAuctionHuman(run, userId);
  await handleAuctionForfeit(run.io as never, human.socket as never);
}

export async function restartAuctionProcess(
  run: RunAuctionResult
) {
  if (!run.matchId) throw new Error('Auction match has not started');
  const state = await auctionStateStore.load(run.matchId);
  if (!state) throw new Error(`Auction state missing for ${run.matchId}`);
  stopRealtimeTimerScheduler();
  clearCurrentAuctionGates(state);
  startRealtimeTimerScheduler(run.io as never, buildRealtimeTimerHandlers());
  return auctionLifecycleService.rearmActiveAuctionTimersOnBoot(run.io as never);
}

export async function getAuctionUserMatchIndexes(
  run: RunAuctionResult
): Promise<Record<string, string | null>> {
  const entries = await Promise.all(run.humans.map(async (human) => (
    [human.userId, await auctionStateStore.getActiveMatchIdForUser(human.userId)] as const
  )));
  return Object.fromEntries(entries);
}

export async function teardownAuctionRun(options: TeardownAuctionRunOptions = {}): Promise<void> {
  stopRealtimeTimerScheduler();
  for (const run of activeRuns) {
    const state = await loadCurrentAuctionState(run.matchId);
    if (state) clearCurrentAuctionGates(state);
  }
  activeRuns.clear();
  const redis = getRedisClient();
  if (redis?.isOpen) await redis.flushDb();
  if (options.closeClients) {
    await Promise.all([
      closeRedisClients(),
      disconnectDb(),
    ]);
  }
}

export async function loadCurrentAuctionState(
  matchId: string | null
): Promise<AuctionMatchState | null> {
  if (!matchId) return null;
  try {
    return await auctionStateStore.load(matchId);
  } catch {
    return null;
  }
}

function resolveHumanPlayers(options: RunAuctionOptions): AuctionMatchHumanPlayer[] {
  if (options.humanPlayers?.length) return [...options.humanPlayers];
  const humanCount = options.humanCount ?? 1;
  return Array.from({ length: humanCount }, (_, index) => ({
    userId: index === 0 && options.userId ? options.userId : AUCTION_USER_IDS[index],
    displayName: `AuctionHarnessHuman${String.fromCharCode(65 + index)}`,
  }));
}

function createReplacementSocket(
  run: RunAuctionResult,
  human: AuctionHarnessHuman
): FakeSocket {
  human.socketGeneration += 1;
  const socket = run.io.createSocket(
    `auction-harness-${human.seatId}-socket-${human.socketGeneration}`,
    {
      user: { id: human.userId, nickname: human.displayName },
      connectedAt: Date.now(),
    }
  );
  socket.join(`user:${human.userId}`);
  return socket;
}

function requireAuctionHuman(
  run: RunAuctionResult,
  userId: string
): AuctionHarnessHuman {
  const human = run.humans.find((entry) => entry.userId === userId);
  if (!human) throw new Error(`Auction harness human not found: ${userId}`);
  return human;
}

async function driveHumanAuctionActions(
  run: RunAuctionResult,
  actionSeatIds: Set<string>
): Promise<void> {
  if (!run.matchId) return;

  for (const event of run.trace.events) {
    if (event.event === 'auction:turn_started') {
      const payload = event.payload as {
        matchId?: string;
        roundId?: string;
        currentTurnSeatId?: string;
        minBid?: number;
        maxBid?: number;
        stateVersion?: number;
      };
      const seatId = payload.currentTurnSeatId;
      const key = `${payload.roundId ?? 'round'}:${seatId ?? 'seat'}:${payload.stateVersion ?? event.seq}`;
      if (
        !seatId
        || !actionSeatIds.has(seatId)
        || run.handledTurns.has(key)
        || payload.matchId !== run.matchId
      ) {
        continue;
      }
      const human = run.humans.find((entry) => entry.seatId === seatId);
      if (!human) continue;
      run.handledTurns.add(key);

      const state = await loadCurrentAuctionState(run.matchId);
      if (
        state?.phase !== 'bidding'
        || state.currentRound?.currentTurnSeatId !== seatId
        || state.seats.find((entry) => entry.seatId === seatId)?.isEliminated
      ) {
        continue;
      }
      if (state.currentRound.highestBidderSeatId) {
        await handleAuctionFold(run.io as never, human.socket as never, { matchId: run.matchId });
      } else if (
        typeof payload.minBid === 'number'
        && typeof payload.maxBid === 'number'
        && payload.minBid <= payload.maxBid
      ) {
        await handleAuctionBid(run.io as never, human.socket as never, {
          matchId: run.matchId,
          amount: payload.minBid,
        });
      }
    }

    if (event.event === 'auction:solo_pick_started') {
      const payload = event.payload as {
        matchId?: string;
        soloPick?: { playerSeatId?: string };
        stateVersion?: number;
      };
      const seatId = payload.soloPick?.playerSeatId;
      const key = `${seatId ?? 'seat'}:${payload.stateVersion ?? event.seq}`;
      if (
        !seatId
        || !actionSeatIds.has(seatId)
        || run.handledSoloPicks.has(key)
        || payload.matchId !== run.matchId
      ) {
        continue;
      }
      const human = run.humans.find((entry) => entry.seatId === seatId);
      if (!human) continue;
      run.handledSoloPicks.add(key);

      const state = await loadCurrentAuctionState(run.matchId);
      if (state?.phase !== 'solo_pick' || state.soloPick?.playerSeatId !== seatId) continue;
      await handleAuctionSoloPickSelect(run.io as never, human.socket as never, {
        matchId: run.matchId,
        option: 'A',
      });
    }
  }
}

function clearCurrentAuctionGates(state: AuctionMatchState): void {
  const roundId = state.currentRound?.roundId;
  if (!roundId) return;
  for (const phase of ['round', 'bidding', 'reveal'] as const) {
    clearAuctionUiReadyGate(state.matchId, phase, roundId, state.version);
  }
}
