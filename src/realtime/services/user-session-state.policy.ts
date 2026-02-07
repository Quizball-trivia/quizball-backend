import type { SessionStateKind } from '../socket.types.js';

export interface SessionPolicyContext {
  activeMatchId: string | null;
  queueSearchId: string | null;
  waitingLobbyIds: string[];
  activeLobbyIds: string[];
}

export interface SessionPolicyDecision {
  state: SessionStateKind;
  shouldBlockLobbyEntry: boolean;
  shouldKeepNewestWaitingLobby: boolean;
  shouldDropExtraWaitingLobbies: boolean;
  shouldDropQueue: boolean;
  shouldDropUnrelatedActiveLobbies: boolean;
}

export function deriveSessionStateKind(context: SessionPolicyContext): SessionStateKind {
  const indicatorCount =
    Number(Boolean(context.activeMatchId)) +
    Number(Boolean(context.queueSearchId)) +
    Number(context.waitingLobbyIds.length > 0);

  if (indicatorCount > 1 || context.waitingLobbyIds.length > 1) {
    return 'CORRUPT_MULTI_STATE';
  }
  if (context.activeMatchId) return 'IN_ACTIVE_MATCH';
  if (context.queueSearchId) return 'IN_QUEUE';
  if (context.waitingLobbyIds.length > 0) return 'IN_WAITING_LOBBY';
  return 'IDLE';
}

export function evaluateSessionPolicy(context: SessionPolicyContext): SessionPolicyDecision {
  const state = deriveSessionStateKind(context);
  const hasActiveMatch = Boolean(context.activeMatchId);
  const hasWaiting = context.waitingLobbyIds.length > 0;

  return {
    state,
    shouldBlockLobbyEntry: hasActiveMatch,
    shouldKeepNewestWaitingLobby: hasWaiting,
    shouldDropExtraWaitingLobbies: context.waitingLobbyIds.length > 1,
    shouldDropQueue: hasActiveMatch || hasWaiting || Boolean(context.queueSearchId),
    shouldDropUnrelatedActiveLobbies: context.activeLobbyIds.length > 0,
  };
}
