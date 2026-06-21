import { harnessDelayMs } from '../../core/harness-timing.js';
import { logger } from '../../core/logger.js';
import type { AuctionMatchState } from '../../modules/auction/auction-match-state.js';
import type { QuizballServer } from '../socket-server.js';
import type { AuctionUiReadyPayload, AuctionUiReadyPhase } from '../socket.types.js';

const AUCTION_UI_READY_CEILING_MS = 8_000;

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
  dispatch: (params: { reason: AuctionUiReadyDispatchReason; missingUserIds: string[] }) => void;
};

const gates = new Map<string, AuctionUiReadyGate>();

function gateKey(matchId: string, phase: AuctionUiReadyPhase, roundId: string, stateVersion: number): string {
  return `${phase}:${matchId}:${roundId}:${stateVersion}`;
}

function getHumanUserIds(state: AuctionMatchState): string[] {
  return state.seats
    .filter((seat) => !seat.isBot && seat.userId)
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

function closeGate(
  key: string,
  gate: AuctionUiReadyGate,
  reason: AuctionUiReadyDispatchReason
): void {
  clearTimeout(gate.timeoutId);
  gates.delete(key);
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
  gate.dispatch({ reason, missingUserIds });
}

export function openAuctionUiReadyGate(params: {
  io: QuizballServer;
  state: AuctionMatchState;
  phase: AuctionUiReadyPhase;
  ceilingMs?: number;
  dispatch: (params: { reason: AuctionUiReadyDispatchReason; missingUserIds: string[] }) => void;
}): void {
  const round = params.state.currentRound;
  if (!round) {
    params.dispatch({ reason: 'empty', missingUserIds: [] });
    return;
  }

  const key = gateKey(params.state.matchId, params.phase, round.roundId, params.state.version);
  const previous = gates.get(key);
  if (previous) {
    clearTimeout(previous.timeoutId);
    gates.delete(key);
  }

  const waitingUserIds = new Set(getHumanUserIds(params.state));
  if (waitingUserIds.size === 0) {
    params.dispatch({ reason: 'empty', missingUserIds: [] });
    return;
  }

  const ceilingMs = harnessDelayMs(params.ceilingMs ?? AUCTION_UI_READY_CEILING_MS, 0);
  const forceStartsAtMs = Date.now() + Math.max(0, ceilingMs);
  const timeoutId = setTimeout(() => {
    const gate = gates.get(key);
    if (!gate) return;
    closeGate(key, gate, 'timeout');
  }, Math.max(0, ceilingMs));
  timeoutId.unref?.();

  const gate: AuctionUiReadyGate = {
    matchId: params.state.matchId,
    phase: params.phase,
    roundId: round.roundId,
    stateVersion: params.state.version,
    waitingUserIds,
    readyUserIds: new Set(),
    forceStartsAtMs,
    timeoutId,
    dispatch: params.dispatch,
  };
  gates.set(key, gate);
  emitGateState(params.io, gate);
}

export function acknowledgeAuctionUiReady(
  io: QuizballServer,
  userId: string,
  payload: AuctionUiReadyPayload
): boolean {
  const key = gateKey(payload.matchId, payload.phase, payload.roundId, payload.stateVersion);
  const gate = gates.get(key);
  if (!gate || !gate.waitingUserIds.has(userId)) return false;
  if (gate.readyUserIds.has(userId)) return true;

  gate.readyUserIds.add(userId);
  emitGateState(io, gate);
  logger.info(
    {
      eventName: 'auction:ui_ready',
      matchId: payload.matchId,
      phase: payload.phase,
      roundId: payload.roundId,
      stateVersion: payload.stateVersion,
      userId,
      readyCount: gate.readyUserIds.size,
      totalCount: gate.waitingUserIds.size,
    },
    'Auction UI-ready ack received'
  );

  if (gate.readyUserIds.size >= gate.waitingUserIds.size) {
    closeGate(key, gate, 'all_ready');
  }
  return true;
}

export function emitAuctionUiReadyGateState(
  io: QuizballServer,
  state: AuctionMatchState,
  phase: AuctionUiReadyPhase
): boolean {
  const round = state.currentRound;
  if (!round) return false;
  const gate = gates.get(gateKey(state.matchId, phase, round.roundId, state.version));
  if (!gate) return false;
  emitGateState(io, gate);
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
  if (!gate) return;
  clearTimeout(gate.timeoutId);
  gates.delete(key);
}
