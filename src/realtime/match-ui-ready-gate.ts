import { logger } from '../core/logger.js';
import type { QuizballServer } from './socket-server.js';
import type { MatchUiReadyPhase } from './socket.types.js';

export type MatchUiReadyDispatchReason = 'all_ready' | 'timeout' | 'empty';

type MatchUiReadyGate = {
  matchId: string;
  phase: MatchUiReadyPhase;
  waitingUserIds: Set<string>;
  readyUserIds: Set<string>;
  forceStartsAtMs: number;
  timeoutId: ReturnType<typeof setTimeout>;
  dispatch: (params: { reason: MatchUiReadyDispatchReason; missingUserIds: string[] }) => void;
};

const gates = new Map<string, MatchUiReadyGate>();

function gateKey(matchId: string, phase: MatchUiReadyPhase): string {
  return `${phase}:${matchId}`;
}

function emitGateState(io: QuizballServer, gate: MatchUiReadyGate): void {
  io.to(`match:${gate.matchId}`).emit('match:waiting_for_ready', {
    matchId: gate.matchId,
    phase: gate.phase,
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
  gate: MatchUiReadyGate,
  reason: MatchUiReadyDispatchReason
): void {
  clearTimeout(gate.timeoutId);
  gates.delete(key);
  const missingUserIds = [...gate.waitingUserIds].filter((userId) => !gate.readyUserIds.has(userId));
  if (missingUserIds.length > 0) {
    logger.info(
      { eventName: 'match:waiting_for_ready', matchId: gate.matchId, phase: gate.phase, reason, missingUserIds },
      'Match UI-ready gate released with missing users'
    );
  }
  gate.dispatch({ reason, missingUserIds });
}

export function openMatchUiReadyGate(params: {
  io: QuizballServer;
  matchId: string;
  phase: MatchUiReadyPhase;
  waitingUserIds: string[];
  ceilingMs: number;
  emitInitial?: boolean;
  dispatch: (params: { reason: MatchUiReadyDispatchReason; missingUserIds: string[] }) => void;
}): void {
  const key = gateKey(params.matchId, params.phase);
  const previous = gates.get(key);
  if (previous) {
    clearTimeout(previous.timeoutId);
    gates.delete(key);
  }

  const waitingUserIds = new Set(params.waitingUserIds);
  if (waitingUserIds.size === 0) {
    params.dispatch({ reason: 'empty', missingUserIds: [] });
    return;
  }

  const forceStartsAtMs = Date.now() + Math.max(0, params.ceilingMs);
  const timeoutId = setTimeout(() => {
    const gate = gates.get(key);
    if (!gate) return;
    closeGate(key, gate, 'timeout');
  }, Math.max(0, params.ceilingMs));
  timeoutId.unref?.();

  const gate: MatchUiReadyGate = {
    matchId: params.matchId,
    phase: params.phase,
    waitingUserIds,
    readyUserIds: new Set(),
    forceStartsAtMs,
    timeoutId,
    dispatch: params.dispatch,
  };
  gates.set(key, gate);

  if (params.emitInitial !== false) {
    emitGateState(params.io, gate);
  }
}

export function emitMatchUiReadyGateState(
  io: QuizballServer,
  matchId: string,
  phase: MatchUiReadyPhase
): void {
  const gate = gates.get(gateKey(matchId, phase));
  if (!gate) return;
  emitGateState(io, gate);
}

export function acknowledgeMatchUiReady(
  io: QuizballServer,
  userId: string,
  matchId: string,
  phase: MatchUiReadyPhase
): boolean {
  const key = gateKey(matchId, phase);
  const gate = gates.get(key);
  if (!gate || !gate.waitingUserIds.has(userId)) return false;
  if (gate.readyUserIds.has(userId)) return true;

  gate.readyUserIds.add(userId);
  emitGateState(io, gate);
  logger.info(
    {
      eventName: 'match:ui_ready',
      matchId,
      phase,
      userId,
      readyCount: gate.readyUserIds.size,
      totalCount: gate.waitingUserIds.size,
    },
    'Match UI-ready ack received'
  );

  if (gate.readyUserIds.size >= gate.waitingUserIds.size) {
    closeGate(key, gate, 'all_ready');
  }
  return true;
}

export function clearMatchUiReadyGate(matchId: string, phase: MatchUiReadyPhase): void {
  const key = gateKey(matchId, phase);
  const gate = gates.get(key);
  if (!gate) return;
  clearTimeout(gate.timeoutId);
  gates.delete(key);
}
