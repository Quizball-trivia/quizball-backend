import { harnessDelayMs } from '../../core/harness-timing.js';
import {
  auctionStateStore,
  saveAuctionMatchMutation,
  skipAuctionMatchMutation,
} from '../../modules/auction/auction-state.store.js';
import {
  findAuctionSeatBySeatId,
  findAuctionSeatByUserId,
  toPublicAuctionMatchState,
  type AuctionMatchState,
} from '../../modules/auction/auction-match-state.js';
import { getRedisClient } from '../redis.js';
import type { QuizballServer } from '../socket-server.js';

export const AUCTION_DISCONNECT_GRACE_MS = 30_000;
export const MAX_AUCTION_DISCONNECTS = 3;
// While a turn is paused for a disconnect, its deadline is pushed THIS far past
// the grace instant (ranked's PAUSE_QUESTION_BACKSTOP_MS pattern). The grace
// forfeit (at pauseUntil) therefore always resolves first — the turn-timeout
// can never race it into an auto-fold that keeps a gone player "playing". The
// backstop only fires as a last resort if the grace timer itself was lost.
export const AUCTION_PAUSE_TURN_BACKSTOP_MS = 90_000;

/** Deadline a paused turn is parked at (far beyond grace + resume countdown). */
export function auctionPausedTurnBackstopEndsAt(pauseUntil: string): string {
  const pauseUntilMs = Date.parse(pauseUntil);
  const baseMs = Number.isFinite(pauseUntilMs) ? pauseUntilMs : Date.now();
  return new Date(baseMs + AUCTION_PAUSE_TURN_BACKSTOP_MS).toISOString();
}

const AUCTION_DISCONNECT_TTL_SEC = 75;
const AUCTION_PAUSE_TTL_SEC = 75;
const AUCTION_RECONNECT_COUNT_TTL_SEC = 10 * 60;

export interface AuctionDisconnectPause {
  matchId: string;
  userId: string;
  seatId: string;
  pauseUntil: string;
  disconnectCount: number;
}

export interface AuctionPausedTurn {
  state: AuctionMatchState;
  pauseUntil: string;
  graceMs: number;
  remainingReconnects: number;
}

export function auctionDisconnectKey(matchId: string, userId: string): string {
  return `auction:disconnect:${matchId}:${userId}`;
}

export function auctionPauseKey(matchId: string): string {
  return `auction:pause:${matchId}`;
}

export function auctionReconnectCountKey(matchId: string, userId: string): string {
  return `auction:reconnect_count:${matchId}:${userId}`;
}

export function toRemainingAuctionReconnects(disconnectCount: number): number {
  return Math.max(0, MAX_AUCTION_DISCONNECTS - disconnectCount);
}

export function getAuctionDisconnectGraceMs(): number {
  return harnessDelayMs(AUCTION_DISCONNECT_GRACE_MS, 150);
}

export async function getAuctionDisconnectCount(matchId: string, userId: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return 0;
  const raw = await redis.get(auctionReconnectCountKey(matchId, userId));
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function incrementAuctionDisconnectCount(matchId: string, userId: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return 0;
  const nextCount = (await getAuctionDisconnectCount(matchId, userId)) + 1;
  await redis.set(auctionReconnectCountKey(matchId, userId), String(nextCount), {
    EX: AUCTION_RECONNECT_COUNT_TTL_SEC,
  });
  return nextCount;
}

export async function markAuctionUserDisconnected(params: {
  matchId: string;
  userId: string;
  seatId: string;
  pauseUntil: string;
  disconnectCount: number;
}): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  await redis.set(auctionDisconnectKey(params.matchId, params.userId), JSON.stringify(params), {
    EX: AUCTION_DISCONNECT_TTL_SEC,
  });
}

export async function clearAuctionUserDisconnected(matchId: string, userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  await redis.del(auctionDisconnectKey(matchId, userId));
}

export async function getAuctionDisconnectedUser(matchId: string, userId: string): Promise<AuctionDisconnectPause | null> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return null;
  const raw = await redis.get(auctionDisconnectKey(matchId, userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuctionDisconnectPause;
    return parsed.matchId === matchId && parsed.userId === userId ? parsed : null;
  } catch {
    return null;
  }
}

export async function getAuctionDisconnectedSeat(state: AuctionMatchState, seatId: string): Promise<AuctionDisconnectPause | null> {
  const seat = findAuctionSeatBySeatId(state, seatId);
  if (!seat?.userId || seat.isBot) return null;
  return getAuctionDisconnectedUser(state.matchId, seat.userId);
}

export async function setAuctionPause(pause: AuctionDisconnectPause): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  await redis.set(auctionPauseKey(pause.matchId), JSON.stringify(pause), {
    EX: AUCTION_PAUSE_TTL_SEC,
  });
}

export async function getAuctionPause(matchId: string): Promise<AuctionDisconnectPause | null> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return null;
  const raw = await redis.get(auctionPauseKey(matchId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuctionDisconnectPause;
    return parsed.matchId === matchId ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearAuctionPause(matchId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  await redis.del(auctionPauseKey(matchId));
}

export async function hasReplacementAuctionMatchSocket(params: {
  io: QuizballServer;
  matchId: string;
  userId: string;
  ignoreSocketId?: string;
}): Promise<boolean> {
  const sockets = await params.io.in(`user:${params.userId}`).fetchSockets();
  return sockets.some((socket) => (
    socket.id !== params.ignoreSocketId &&
    socket.rooms.has(`match:${params.matchId}`)
  ));
}

export async function pauseAuctionCurrentTurnIfDisconnected(
  state: AuctionMatchState
): Promise<AuctionPausedTurn | null> {
  const round = state.currentRound;
  if (state.phase !== 'bidding' || !round?.currentTurnSeatId) return null;

  const disconnected = await getAuctionDisconnectedSeat(state, round.currentTurnSeatId);
  if (!disconnected) return null;

  return pauseAuctionCurrentTurnForDisconnectedSeat(state, disconnected);
}

export async function pauseAuctionCurrentTurnForDisconnectedSeat(
  state: AuctionMatchState,
  disconnected: AuctionDisconnectPause
): Promise<AuctionPausedTurn | null> {
  // Park the paused turn FAR past the grace instant so the grace forfeit (at
  // pauseUntil) always resolves before the turn-timeout can auto-fold.
  const backstopEndsAt = auctionPausedTurnBackstopEndsAt(disconnected.pauseUntil);
  const round = state.currentRound;
  if (
    state.phase !== 'bidding' ||
    !round ||
    round.currentTurnSeatId !== disconnected.seatId ||
    round.turnEndsAt === backstopEndsAt
  ) {
    return null;
  }

  const saved = await auctionStateStore.mutate(state.matchId, (current) => {
    const currentRound = current.currentRound;
    if (
      current.phase !== 'bidding' ||
      !currentRound ||
      currentRound.currentTurnSeatId !== disconnected.seatId ||
      currentRound.turnEndsAt === backstopEndsAt
    ) {
      return skipAuctionMatchMutation(null);
    }

    const seat = findAuctionSeatByUserId(current, disconnected.userId);
    if (!seat || seat.seatId !== disconnected.seatId || seat.isBot || seat.isEliminated) {
      return skipAuctionMatchMutation(null);
    }

    return saveAuctionMatchMutation({
      ...current,
      currentRound: {
        ...currentRound,
        turnEndsAt: backstopEndsAt,
        updatedAt: new Date().toISOString(),
      },
    }, (next) => next);
  }, {
    onMissingState: () => null,
  });

  if (!saved) return null;
  await setAuctionPause(disconnected);
  const pauseUntilMs = Date.parse(disconnected.pauseUntil);
  const graceMs = Number.isFinite(pauseUntilMs)
    ? Math.max(0, pauseUntilMs - Date.now())
    : getAuctionDisconnectGraceMs();
  return {
    state: saved,
    pauseUntil: disconnected.pauseUntil,
    graceMs,
    remainingReconnects: toRemainingAuctionReconnects(disconnected.disconnectCount),
  };
}

export function buildAuctionPausedStatePayload(paused: AuctionPausedTurn) {
  return {
    matchId: paused.state.matchId,
    state: toPublicAuctionMatchState(paused.state),
    stateVersion: paused.state.version,
    serverNow: new Date().toISOString(),
  };
}
