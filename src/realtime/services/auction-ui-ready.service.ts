import { harnessDelayMs } from '../../core/harness-timing.js';
import { logger } from '../../core/logger.js';
import type { AuctionMatchState } from '../../modules/auction/auction-match-state.js';
import {
  auctionStateStore,
  AuctionMatchLockUnavailableError,
} from '../../modules/auction/auction-state.store.js';
import { getRedisClient } from '../redis.js';
import type { QuizballServer } from '../socket-server.js';
import type { AuctionUiReadyPayload, AuctionUiReadyPhase } from '../socket.types.js';
import { scheduleAuctionAdvanceRetryTimer } from './auction-advance-retry-timer.js';

const AUCTION_UI_READY_CEILING_MS = 8_000;
export const AUCTION_FIRST_ROUND_UI_READY_CEILING_MS = 20_000;
const AUCTION_UI_READY_TTL_SECONDS = 60;
const AUCTION_UI_READY_POLL_MS = 25;
const AUCTION_UI_READY_DISPATCH_LOCK_RETRY_MS = 25;
const AUCTION_UI_READY_DISPATCH_LOCK_ATTEMPTS = 200;

type AuctionUiReadyDispatchReason = 'all_ready' | 'timeout' | 'empty';

type AuctionUiReadyGate = {
  matchId: string;
  phase: AuctionUiReadyPhase;
  roundId: string;
  stateVersion: number;
  waitingUserIds: Set<string>;
  readyUserIds: Set<string>;
  forceStartsAtMs: number;
  timeoutId: ReturnType<typeof setTimeout>;
  pollId: ReturnType<typeof setInterval>;
  closing: boolean;
  dispatch: (params: { reason: AuctionUiReadyDispatchReason; missingUserIds: string[] }) => void | Promise<void>;
};

const gates = new Map<string, AuctionUiReadyGate>();

function gateKey(matchId: string, phase: AuctionUiReadyPhase, roundId: string, stateVersion: number): string {
  return `${phase}:${matchId}:${roundId}:${stateVersion}`;
}

function expectedKey(key: string): string {
  return `auction:ui_ready:${key}:expected`;
}

function ackKey(key: string): string {
  return `auction:ui_ready:${key}:acks`;
}

function releaseKey(key: string): string {
  return `auction:ui_ready:${key}:released`;
}

function forceStartsAtKey(key: string): string {
  return `auction:ui_ready:${key}:force_starts_at`;
}

function getHumanUserIds(state: AuctionMatchState): string[] {
  return state.seats
    .filter((seat) => !seat.isBot && seat.userId && !seat.forfeited && !seat.isEliminated)
    .map((seat) => seat.userId as string);
}

function emitGateState(io: QuizballServer, gate: AuctionUiReadyGate): void {
  io.to(`match:${gate.matchId}`).emit('auction:waiting_for_ready', {
    matchId: gate.matchId,
    phase: gate.phase,
    roundId: gate.roundId,
    stateVersion: gate.stateVersion,
    readyCount: gate.readyUserIds.size,
    totalCount: gate.waitingUserIds.size,
    readyUserIds: [...gate.readyUserIds],
    waitingUserIds: [...gate.waitingUserIds],
    forceStartsAt: new Date(gate.forceStartsAtMs).toISOString(),
    serverNow: new Date().toISOString(),
  });
}

function removeLocalGate(key: string, gate: AuctionUiReadyGate): void {
  clearTimeout(gate.timeoutId);
  clearInterval(gate.pollId);
  if (gates.get(key) === gate) gates.delete(key);
}

function dispatchGateAfterRelease(
  gate: Pick<AuctionUiReadyGate, 'matchId' | 'phase' | 'roundId' | 'stateVersion' | 'dispatch'>,
  reason: AuctionUiReadyDispatchReason,
  missingUserIds: string[]
): void {
  // Gate persistence/completeness can resolve from microtasks started while the
  // caller is still unwinding an auction-state mutation. Dispatching inline
  // there lets a downstream mutate re-enter the same non-reentrant match lock.
  // A macrotask boundary guarantees dispatch is no longer on the opener's
  // stack; downstream failures are observed instead of becoming unhandled.
  const dispatch = (attempt: number): void => {
    Promise.resolve()
      .then(() => gate.dispatch({ reason, missingUserIds }))
      .catch((error) => {
        if (
          error instanceof AuctionMatchLockUnavailableError
          && attempt < AUCTION_UI_READY_DISPATCH_LOCK_ATTEMPTS
        ) {
          const retry = setTimeout(
            () => dispatch(attempt + 1),
            harnessDelayMs(AUCTION_UI_READY_DISPATCH_LOCK_RETRY_MS, 1)
          );
          retry.unref?.();
          return;
        }
        logger.warn({
          error,
          matchId: gate.matchId,
          phase: gate.phase,
          roundId: gate.roundId,
          stateVersion: gate.stateVersion,
        }, 'Auction UI-ready gate dispatch failed');
        void scheduleAuctionAdvanceRetryTimer(gate.matchId, gate.phase).catch((scheduleError) => {
          logger.error({
            err: scheduleError,
            matchId: gate.matchId,
            phase: gate.phase,
          }, 'Failed to schedule durable auction advance retry');
        });
      });
  };
  setImmediate(() => dispatch(1));
}

async function refreshReadyUsers(key: string, gate: AuctionUiReadyGate): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  const readyUserIds = await redis.sMembers(ackKey(key));
  let changed = false;
  for (const userId of readyUserIds) {
    if (!gate.waitingUserIds.has(userId) || gate.readyUserIds.has(userId)) continue;
    gate.readyUserIds.add(userId);
    changed = true;
  }
  if (changed) emitGateStateForOwner(gate);
}

async function refreshWaitingUsers(key: string, gate: AuctionUiReadyGate): Promise<void> {
  if (typeof auctionStateStore.load !== 'function') return;
  const state = await auctionStateStore.load(gate.matchId).catch(() => null);
  if (!state || state.currentRound?.roundId !== gate.roundId) return;

  const liveUserIds = new Set(getHumanUserIds(state));
  const removedUserIds = [...gate.waitingUserIds].filter((userId) => !liveUserIds.has(userId));
  if (removedUserIds.length === 0) return;

  for (const userId of removedUserIds) {
    gate.waitingUserIds.delete(userId);
    gate.readyUserIds.delete(userId);
  }

  const redis = getRedisClient();
  if (redis?.isOpen) {
    await redis.sRem(expectedKey(key), removedUserIds);
  }
  emitGateStateForOwner(gate);
}

const ownerIo = new WeakMap<AuctionUiReadyGate, QuizballServer>();

function emitGateStateForOwner(gate: AuctionUiReadyGate): void {
  const io = ownerIo.get(gate);
  if (io) emitGateState(io, gate);
}

async function closeGate(
  key: string,
  gate: AuctionUiReadyGate,
  reason: AuctionUiReadyDispatchReason
): Promise<void> {
  if (gate.closing) return;
  gate.closing = true;

  try {
    await refreshWaitingUsers(key, gate);
    await refreshReadyUsers(key, gate);
    const redis = getRedisClient();
    if (redis?.isOpen) {
      const claimed = await redis.set(releaseKey(key), reason, {
        NX: true,
        EX: AUCTION_UI_READY_TTL_SECONDS,
      });
      if (claimed !== 'OK') {
        removeLocalGate(key, gate);
        return;
      }
    }

    removeLocalGate(key, gate);
    const missingUserIds = [...gate.waitingUserIds].filter((userId) => !gate.readyUserIds.has(userId));
    if (missingUserIds.length > 0) {
      logger.info(
        {
          eventName: 'auction:waiting_for_ready',
          matchId: gate.matchId,
          phase: gate.phase,
          roundId: gate.roundId,
          stateVersion: gate.stateVersion,
          reason,
          missingUserIds,
        },
        'Auction UI-ready gate released with missing users'
      );
    }
    dispatchGateAfterRelease(gate, reason, missingUserIds);
  } catch (error) {
    if (reason === 'timeout') {
      removeLocalGate(key, gate);
      const missingUserIds = [...gate.waitingUserIds].filter((userId) => !gate.readyUserIds.has(userId));
      dispatchGateAfterRelease(gate, reason, missingUserIds);
      return;
    }
    gate.closing = false;
    logger.warn({ error, key }, 'Failed to release shared auction UI-ready gate');
  }
}

async function checkGateCompleteness(key: string, gate: AuctionUiReadyGate): Promise<void> {
  if (gate.closing) return;
  try {
    await refreshWaitingUsers(key, gate);
    await refreshReadyUsers(key, gate);
    if ([...gate.waitingUserIds].every((userId) => gate.readyUserIds.has(userId))) {
      await closeGate(key, gate, 'all_ready');
    }
  } catch (error) {
    logger.warn({ error, key }, 'Failed to check shared auction UI-ready gate');
  }
}

async function persistGate(key: string, gate: AuctionUiReadyGate): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  try {
    await redis.sAdd(expectedKey(key), [...gate.waitingUserIds]);
    await Promise.all([
      redis.set(forceStartsAtKey(key), String(gate.forceStartsAtMs), { EX: AUCTION_UI_READY_TTL_SECONDS }),
      redis.expire(expectedKey(key), AUCTION_UI_READY_TTL_SECONDS),
      redis.expire(ackKey(key), AUCTION_UI_READY_TTL_SECONDS),
    ]);
    await checkGateCompleteness(key, gate);
  } catch (error) {
    logger.warn({ error, key }, 'Failed to persist shared auction UI-ready gate');
  }
}

export function openAuctionUiReadyGate(params: {
  io: QuizballServer;
  state: AuctionMatchState;
  phase: AuctionUiReadyPhase;
  ceilingMs?: number;
  dispatch: (params: { reason: AuctionUiReadyDispatchReason; missingUserIds: string[] }) => void | Promise<void>;
}): void {
  const round = params.state.currentRound;
  if (!round) {
    dispatchGateAfterRelease({
      matchId: params.state.matchId,
      phase: params.phase,
      roundId: '',
      stateVersion: params.state.version,
      dispatch: params.dispatch,
    }, 'empty', []);
    return;
  }

  const key = gateKey(params.state.matchId, params.phase, round.roundId, params.state.version);
  const previous = gates.get(key);
  if (previous) removeLocalGate(key, previous);

  const waitingUserIds = new Set(getHumanUserIds(params.state));
  if (waitingUserIds.size === 0) {
    dispatchGateAfterRelease({
      matchId: params.state.matchId,
      phase: params.phase,
      roundId: round.roundId,
      stateVersion: params.state.version,
      dispatch: params.dispatch,
    }, 'empty', []);
    return;
  }

  const ceilingMs = harnessDelayMs(params.ceilingMs ?? AUCTION_UI_READY_CEILING_MS, 0);
  const forceStartsAtMs = Date.now() + Math.max(0, ceilingMs);
  const timeoutId = setTimeout(() => {
    const gate = gates.get(key);
    if (gate) void closeGate(key, gate, 'timeout');
  }, Math.max(0, ceilingMs));
  timeoutId.unref?.();

  const pollId = setInterval(() => {
    const gate = gates.get(key);
    if (gate) void checkGateCompleteness(key, gate);
  }, AUCTION_UI_READY_POLL_MS);
  pollId.unref?.();

  const gate: AuctionUiReadyGate = {
    matchId: params.state.matchId,
    phase: params.phase,
    roundId: round.roundId,
    stateVersion: params.state.version,
    waitingUserIds,
    readyUserIds: new Set(),
    forceStartsAtMs,
    timeoutId,
    pollId,
    closing: false,
    dispatch: params.dispatch,
  };
  gates.set(key, gate);
  ownerIo.set(gate, params.io);
  emitGateState(params.io, gate);
  void persistGate(key, gate);
}

export async function acknowledgeAuctionUiReady(
  io: QuizballServer,
  userId: string,
  payload: AuctionUiReadyPayload
): Promise<boolean> {
  const key = gateKey(payload.matchId, payload.phase, payload.roundId, payload.stateVersion);
  const gate = gates.get(key);
  if (gate) await refreshWaitingUsers(key, gate);
  if (gate?.waitingUserIds.has(userId)) {
    if (!gate.readyUserIds.has(userId)) {
      gate.readyUserIds.add(userId);
      emitGateState(io, gate);
    }
  }

  const redis = getRedisClient();
  if (redis?.isOpen) {
    try {
      await redis.sAdd(ackKey(key), userId);
      await redis.expire(ackKey(key), AUCTION_UI_READY_TTL_SECONDS);
      const [expectedUserIds, readyUserIds] = await Promise.all([
        redis.sMembers(expectedKey(key)),
        redis.sMembers(ackKey(key)),
      ]);
      if (!expectedUserIds.includes(userId)) return false;
      if (gate && expectedUserIds.every((expectedUserId) => readyUserIds.includes(expectedUserId))) {
        await closeGate(key, gate, 'all_ready');
      }
      logAcknowledgement(payload, userId, readyUserIds.length, expectedUserIds.length);
      return true;
    } catch (error) {
      logger.warn({ error, key, userId }, 'Failed to record shared auction UI-ready ack');
    }
  }

  if (!gate?.waitingUserIds.has(userId)) return false;
  logAcknowledgement(payload, userId, gate.readyUserIds.size, gate.waitingUserIds.size);
  if ([...gate.waitingUserIds].every((waitingUserId) => gate.readyUserIds.has(waitingUserId))) {
    await closeGate(key, gate, 'all_ready');
  }
  return true;
}

function logAcknowledgement(
  payload: AuctionUiReadyPayload,
  userId: string,
  readyCount: number,
  totalCount: number
): void {
  logger.info(
    {
      eventName: 'auction:ui_ready',
      matchId: payload.matchId,
      phase: payload.phase,
      roundId: payload.roundId,
      stateVersion: payload.stateVersion,
      userId,
      readyCount,
      totalCount,
    },
    'Auction UI-ready ack received'
  );
}

export async function emitAuctionUiReadyGateState(
  io: QuizballServer,
  state: AuctionMatchState,
  phase: AuctionUiReadyPhase
): Promise<boolean> {
  const round = state.currentRound;
  if (!round) return false;
  const key = gateKey(state.matchId, phase, round.roundId, state.version);
  const gate = gates.get(key);
  if (gate) {
    emitGateState(io, gate);
    return true;
  }

  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  const [waitingUserIds, readyUserIds, forceStartsAtRaw] = await Promise.all([
    redis.sMembers(expectedKey(key)),
    redis.sMembers(ackKey(key)),
    redis.get(forceStartsAtKey(key)),
  ]);
  if (waitingUserIds.length === 0 || await redis.get(releaseKey(key))) return false;
  const forceStartsAtMs = Number(forceStartsAtRaw);
  io.to(`match:${state.matchId}`).emit('auction:waiting_for_ready', {
    matchId: state.matchId,
    phase,
    roundId: round.roundId,
    stateVersion: state.version,
    readyCount: readyUserIds.length,
    totalCount: waitingUserIds.length,
    readyUserIds,
    waitingUserIds,
    forceStartsAt: new Date(Number.isFinite(forceStartsAtMs) ? forceStartsAtMs : Date.now()).toISOString(),
    serverNow: new Date().toISOString(),
  });
  return true;
}

export function clearAuctionUiReadyGate(
  matchId: string,
  phase: AuctionUiReadyPhase,
  roundId: string,
  stateVersion: number
): void {
  const key = gateKey(matchId, phase, roundId, stateVersion);
  const gate = gates.get(key);
  if (gate) removeLocalGate(key, gate);
}
