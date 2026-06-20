/**
 * In-process Auction runner: seeds published Auction clue-card content into the
 * local regression DB, starts a REAL Auction AI match through the production
 * realtime service, and lets durable Redis timers + bots drive the match.
 */
import { FakeIo, createTrace, type EventTrace, type FakeSocket } from './adapter.mjs';
import {
  seedAuctionFixtures,
  seedTestUserWithTicket,
  type SeededAuctionFixtures,
} from './fixtures.mjs';

import { getRedisClient, initRedisClients } from '../../src/realtime/redis.js';
import { startRealtimeTimerScheduler, stopRealtimeTimerScheduler } from '../../src/realtime/realtime-timer-scheduler.js';
import { buildRealtimeTimerHandlers } from '../../src/realtime/socket-server.js';
import { auctionRealtimeService } from '../../src/realtime/services/auction-realtime.service.js';
import {
  handleAuctionBid,
  handleAuctionFold,
  handleAuctionSoloPickSelect,
} from '../../src/realtime/services/auction-turn.service.js';
import { auctionStateStore } from '../../src/modules/auction/auction-state.store.js';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { FormationName } from '../../src/modules/auction/auction.types.js';

const AUCTION_USER_ID = '00000000-0000-0000-0000-00000000a001';

export interface RunAuctionResult {
  trace: EventTrace;
  fixtures: SeededAuctionFixtures;
  userId: string;
  matchId: string | null;
  humanSeatId: string | null;
  io: FakeIo;
  socket: FakeSocket;
}

export interface RunAuctionOptions {
  userId?: string;
  formation?: FormationName;
  locale?: 'en' | 'ka';
  startTimeoutMs?: number;
}

export interface PlayAuctionOptions {
  maxMs?: number;
  tickMs?: number;
}

async function waitUntil(predicate: () => boolean, maxMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  if (predicate()) return true;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    if (predicate()) return true;
  }
  return false;
}

export async function bootAuctionMatch(options: RunAuctionOptions = {}): Promise<RunAuctionResult> {
  const userId = options.userId ?? AUCTION_USER_ID;
  const locale = options.locale ?? 'en';
  const formation = options.formation ?? '4-3-3';
  const now = () => Date.now();
  const trace = createTrace(now);
  const io = new FakeIo(trace);

  const fixtures = await seedAuctionFixtures();
  await seedTestUserWithTicket({ userId, nickname: 'AuctionHarnessBot', tickets: 0 });

  await initRedisClients();
  const redisForFlush = getRedisClient();
  if (redisForFlush?.isOpen) await redisForFlush.flushDb();
  startRealtimeTimerScheduler(io as never, buildRealtimeTimerHandlers());

  const socket = io.createSocket('auction-harness-socket-1', {
    user: { id: userId, nickname: 'AuctionHarnessBot' },
    connectedAt: now(),
  });
  socket.join(`user:${userId}`);

  await auctionRealtimeService.handleStartAiMatch(
    io as never,
    socket as never,
    { locale, formation }
  );

  const started = await waitUntil(
    () => trace.byEvent('auction:match_started').length > 0 && trace.byEvent('auction:round_started').length > 0,
    options.startTimeoutMs ?? 10_000
  );

  let matchId: string | null = null;
  let humanSeatId: string | null = null;
  if (started) {
    const payload = trace.byEvent('auction:match_started')[0]?.payload as {
      matchId?: string;
      state?: { seats?: Array<{ seatId: string; userId?: string | null; isBot?: boolean }> };
    } | undefined;
    matchId = payload?.matchId ?? null;
    humanSeatId = payload?.state?.seats?.find((seat) => seat.userId === userId && !seat.isBot)?.seatId ?? null;
    if (matchId) socket.data.matchId = matchId;
  }

  return { trace, fixtures, userId, matchId, humanSeatId, io, socket };
}

export async function playAuctionMatch(
  run: RunAuctionResult,
  options: PlayAuctionOptions = {}
): Promise<void> {
  const maxMs = options.maxMs ?? 120_000;
  const tickMs = options.tickMs ?? 25;
  const deadline = Date.now() + maxMs;
  const handledTurns = new Set<string>();
  const handledSoloPicks = new Set<string>();

  while (Date.now() < deadline) {
    await driveHumanAuctionActions(run, handledTurns, handledSoloPicks);
    if (run.trace.byEvent('auction:match_finished').length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }
}

export async function runFullAuctionMatch(options: RunAuctionOptions = {}): Promise<RunAuctionResult> {
  const run = await bootAuctionMatch(options);
  if (run.matchId) await playAuctionMatch(run);
  return run;
}

export async function teardownAuctionRun(): Promise<void> {
  stopRealtimeTimerScheduler();
  const redis = getRedisClient();
  if (redis?.isOpen) await redis.flushDb();
}

async function driveHumanAuctionActions(
  run: RunAuctionResult,
  handledTurns: Set<string>,
  handledSoloPicks: Set<string>
): Promise<void> {
  if (!run.matchId || !run.humanSeatId) return;

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
      const key = `${payload.roundId ?? 'round'}:${payload.currentTurnSeatId ?? 'seat'}:${payload.stateVersion ?? event.seq}`;
      if (handledTurns.has(key) || payload.matchId !== run.matchId || payload.currentTurnSeatId !== run.humanSeatId) {
        continue;
      }
      handledTurns.add(key);

      const state = await loadCurrentAuctionState(run.matchId);
      if (state?.phase !== 'bidding' || state.currentRound?.currentTurnSeatId !== run.humanSeatId) continue;
      if (state.currentRound.highestBidderSeatId) {
        await handleAuctionFold(run.io as never, run.socket as never, { matchId: run.matchId });
      } else if (typeof payload.minBid === 'number' && typeof payload.maxBid === 'number' && payload.minBid <= payload.maxBid) {
        await handleAuctionBid(run.io as never, run.socket as never, {
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
      const key = `${payload.soloPick?.playerSeatId ?? 'seat'}:${payload.stateVersion ?? event.seq}`;
      if (handledSoloPicks.has(key) || payload.matchId !== run.matchId || payload.soloPick?.playerSeatId !== run.humanSeatId) {
        continue;
      }
      handledSoloPicks.add(key);

      const state = await loadCurrentAuctionState(run.matchId);
      if (state?.phase !== 'solo_pick' || state.soloPick?.playerSeatId !== run.humanSeatId) continue;
      await handleAuctionSoloPickSelect(run.io as never, run.socket as never, {
        matchId: run.matchId,
        option: 'A',
      });
    }
  }
}

async function loadCurrentAuctionState(matchId: string): Promise<AuctionMatchState | null> {
  try {
    return await auctionStateStore.load(matchId);
  } catch {
    return null;
  }
}
