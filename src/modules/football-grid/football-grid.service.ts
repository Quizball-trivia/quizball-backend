import { createHash, randomUUID } from 'node:crypto';
import {
  AppError,
  AuthorizationError,
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
} from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import type { TransactionSql } from '../../db/index.js';
import {
  acknowledgeHandoff,
  applyResolvedAnswer,
  cancelNoContest,
  expireTurn,
  forfeitMatch,
  markReady,
  passTurn,
  pauseForDisconnect,
  resumeAfterReconnect,
  shortenDisconnectPause,
  startTurnAfterCountdown,
  FOOTBALL_GRID_RECONNECT_MS,
  FootballGridRuleError,
} from './football-grid.engine.js';
import { resolveFootballGridAnswer } from './football-grid.answer-resolver.js';
import { footballGridRepo, type FootballGridCommandInboxRow } from './football-grid.repo.js';
import type {
  FootballGridOrigin,
  FootballGridResolvedAnswer,
  FootballGridState,
} from './football-grid.types.js';

export interface FootballGridCommandResult {
  outcome: 'correct' | 'wrong' | 'ambiguous' | 'already_used' | 'pass';
  state: FootballGridState;
  resolvedPlayerId: string | null;
  attemptId: string | null;
  duplicate: boolean;
}

type FootballGridBoardAnswerContent = Awaited<ReturnType<typeof footballGridRepo.getAliasesForBoard>>;
const BOARD_ANSWER_CACHE_TTL_MS = 10 * 60_000;
const BOARD_ANSWER_CACHE_MAX_ENTRIES = 512;
type BoardAnswerCacheEntry = {
  generation: number;
  value: FootballGridBoardAnswerContent | null;
  expiresAt: number;
};
const boardAnswerCache = new Map<string, BoardAnswerCacheEntry>();

function trimBoardAnswerCache(): void {
  while (boardAnswerCache.size > BOARD_ANSWER_CACHE_MAX_ENTRIES) {
    const oldestKey = boardAnswerCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    boardAnswerCache.delete(oldestKey);
  }
}

function invalidateBoardAnswerContent(matchId: string): void {
  const current = boardAnswerCache.get(matchId);
  boardAnswerCache.delete(matchId);
  boardAnswerCache.set(matchId, {
    generation: (current?.generation ?? 0) + 1,
    value: null,
    expiresAt: Date.now() + BOARD_ANSWER_CACHE_TTL_MS,
  });
  trimBoardAnswerCache();
}

async function getBoardAnswerContent(matchId: string): Promise<FootballGridBoardAnswerContent> {
  const now = Date.now();
  const cached = boardAnswerCache.get(matchId);
  if (cached?.value && cached.expiresAt > now) {
    boardAnswerCache.delete(matchId);
    boardAnswerCache.set(matchId, cached);
    return cached.value;
  }
  const generation = cached?.generation ?? 0;
  if (cached && cached.expiresAt <= now) boardAnswerCache.delete(matchId);
  const value = await footballGridRepo.getAliasesForBoard(matchId);
  const state = await currentOrThrow(matchId);
  const latestGeneration = boardAnswerCache.get(matchId)?.generation ?? 0;
  if (state.phase === 'terminal' || latestGeneration !== generation) return value;
  boardAnswerCache.delete(matchId);
  boardAnswerCache.set(matchId, {
    generation,
    value,
    expiresAt: Date.now() + BOARD_ANSWER_CACHE_TTL_MS,
  });
  trimBoardAnswerCache();
  return value;
}

function commandPayloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function toDomainError(error: unknown): Error {
  if (error instanceof FootballGridRuleError) {
    if (error.code === 'NOT_PARTICIPANT') return new AuthorizationError(error.message);
    if (error.code === 'INVALID_CELL') return new BadRequestError(error.message);
    return new ConflictError(error.message, { gridCode: error.code });
  }
  if (error instanceof Error) {
    if (error.message === 'Football Grid match not found') return new NotFoundError(error.message);
    if (error.message === 'NOT_PARTICIPANT') return new AuthorizationError('Not a Football Grid participant');
    if (error.message === 'LATE_COMMAND') return new ConflictError('Turn deadline has passed', { gridCode: 'LATE_COMMAND' });
    if (
      error.message === 'COMMAND_IN_PROGRESS'
      || error.message === 'COMMAND_ID_REUSED'
      || error.message === 'STALE_STATE'
      || error.message === 'INVALID_STATE'
      || error.message === 'NOT_YOUR_TURN'
    ) {
      return new ConflictError('Football Grid command rejected', { gridCode: error.message });
    }
  }
  return error instanceof Error ? error : new InternalError('Football Grid command failed');
}

async function currentOrThrow(matchId: string): Promise<FootballGridState> {
  const state = await footballGridRepo.loadState(matchId);
  if (!state) throw new NotFoundError('Football Grid match not found');
  return state;
}

function assertBarrierVersion(
  state: FootballGridState,
  userId: string,
  expectedStateVersion: number,
  barrier: 'handoff' | 'ready',
): void {
  if (expectedStateVersion === state.stateVersion) return;
  const peer = state.players.find((player) => player.userId !== userId);
  const peerAlreadyCrossed = peer?.isBot === false && (barrier === 'handoff'
    ? peer.handoffAcknowledged === true
    : peer.ready === true);
  if (peerAlreadyCrossed && expectedStateVersion === state.stateVersion - 1) return;
  throw new ConflictError('Stale Football Grid barrier state', { gridCode: 'STALE_STATE' });
}

async function returnDuplicate(inbox: FootballGridCommandInboxRow): Promise<FootballGridCommandResult | null> {
  const attempt = await footballGridRepo.getAttemptForInbox(inbox.id);
  if (!attempt) return null;
  return {
    outcome: attempt.outcome,
    state: await currentOrThrow(inbox.match_id),
    resolvedPlayerId: attempt.resolvedPlayerId,
    attemptId: attempt.attemptId,
    duplicate: true,
  };
}

function replayTerminalCommandError(inbox: FootballGridCommandInboxRow): Error | null {
  if (inbox.status !== 'cancelled' && inbox.status !== 'failed') return null;
  const message = inbox.status === 'failed'
    ? 'Football Grid command could not be completed'
    : inbox.last_error ?? 'Football Grid command was rejected';
  return new ConflictError(message, {
    ...(inbox.result_payload ?? {}),
    gridCode: inbox.result_code ?? (inbox.status === 'failed' ? 'GRID_SERVICE_INTERRUPTION' : 'COMMAND_REJECTED'),
    duplicate: true,
  });
}

async function processInbox(
  inbox: FootballGridCommandInboxRow,
): Promise<FootballGridCommandResult> {
  const duplicate = await returnDuplicate(inbox);
  if (duplicate) return duplicate;
  const replayedError = replayTerminalCommandError(inbox);
  if (replayedError) throw replayedError;
  const processingFence = randomUUID();
  const leased = await footballGridRepo.leaseCommand(inbox.id, processingFence);
  if (!leased) {
    const repeated = await returnDuplicate(inbox);
    if (repeated) return repeated;
    const current = await footballGridRepo.getCommandInbox(inbox.id);
    if (current) {
      const currentDuplicate = await returnDuplicate(current);
      if (currentDuplicate) return currentDuplicate;
      const currentError = replayTerminalCommandError(current);
      if (currentError) throw currentError;
    }
    throw new ConflictError('Football Grid command is already processing', { gridCode: 'COMMAND_IN_PROGRESS' });
  }

  let resolution: FootballGridResolvedAnswer | null = null;
  try {
    if (leased.command_type === 'answer') {
      if (leased.cell_index === null || !leased.locale || !leased.submitted_text) {
        throw new BadRequestError('Answer command is incomplete');
      }
      const content = await getBoardAnswerContent(leased.match_id);
      const preState = await currentOrThrow(leased.match_id);
      const resolverStartedAt = performance.now();
      resolution = resolveFootballGridAnswer({
        submittedText: leased.submitted_text,
        aliases: content.aliases,
        validPlayerIds: content.validPlayerIdsByCell.get(leased.cell_index) ?? [],
        boardPlayerIds: content.boardPlayerIds,
        usedPlayerIds: preState.claims.map((claim) => claim.footballPlayerId),
      });
      appMetrics.footballGridResolverDuration.record(performance.now() - resolverStartedAt);
    }

    const result = await footballGridRepo.runInTransaction(async (tx) => {
      const previous = await footballGridRepo.loadStateForUpdate(tx, leased.match_id);
      if (!previous) throw new NotFoundError('Football Grid match not found');
      if (previous.stateVersion !== leased.expected_state_version) {
        throw new ConflictError('Football Grid state changed while command was pending', { gridCode: 'STALE_STATE' });
      }
      let next: FootballGridState;
      let outcome: FootballGridCommandResult['outcome'];
      if (leased.command_type === 'pass') {
        outcome = 'pass';
        next = passTurn(previous, leased.actor_user_id, leased.expected_state_version, await footballGridRepo.databaseNowMs(tx));
      } else if (leased.command_type === 'answer' && resolution) {
        outcome = resolution.outcome;
        next = applyResolvedAnswer(previous, {
          userId: leased.actor_user_id,
          expectedStateVersion: leased.expected_state_version,
          cellIndex: leased.cell_index!,
          outcome: resolution.outcome,
          footballPlayerId: resolution.playerId,
          nowMs: await footballGridRepo.databaseNowMs(tx),
        });
      } else {
        throw new BadRequestError('Unsupported Football Grid command');
      }
      await footballGridRepo.finishCommandInTx({
        tx,
        inbox: leased,
        processingFence,
        previous,
        next,
        outcome,
        normalizedText: resolution?.normalizedInput ?? null,
        resolvedPlayerId: resolution?.playerId ?? null,
        aliasId: resolution?.aliasId ?? null,
        eventType: outcome === 'correct' ? 'cell_claimed' : `turn_${outcome}`,
      });
      return { outcome, state: next, resolvedPlayerId: resolution?.playerId ?? null, attemptId: null, duplicate: false };
    });
    const attempt = await footballGridRepo.getAttemptForInbox(inbox.id);
    const persistedState = await currentOrThrow(inbox.match_id);
    if (persistedState.phase === 'terminal') invalidateBoardAnswerContent(inbox.match_id);
    appMetrics.footballGridCommands.add(1, { outcome: result.outcome, command_type: leased.command_type });
    return { ...result, state: persistedState, attemptId: attempt?.attemptId ?? null };
  } catch (error) {
    const domainError = toDomainError(error);
    if (domainError instanceof BadRequestError || domainError instanceof ConflictError || domainError instanceof AuthorizationError) {
      const details = domainError instanceof AppError && domainError.details && typeof domainError.details === 'object'
        ? domainError.details as Record<string, unknown>
        : {};
      await footballGridRepo.cancelCommand({
        commandInboxId: inbox.id,
        processingFence,
        reason: domainError.message,
        resultCode: typeof details.gridCode === 'string' ? details.gridCode : domainError.code,
        resultPayload: { ...details, appCode: domainError.code },
      }).catch((cancelError) => {
        logger.error({ cancelError, commandInboxId: inbox.id }, 'Failed to clear rejected Football Grid command');
      });
    } else {
      await footballGridRepo.markCommandFailed({
        commandInboxId: inbox.id,
        processingFence,
        errorMessage: domainError.message,
      }).catch((markError) => {
        logger.error({ markError, commandInboxId: inbox.id }, 'Failed to persist Football Grid command failure');
      });
    }
    throw domainError;
  }
}

export const footballGridService = {
  async createMatch(input: {
    pairingToken: string;
    lobbyId?: string | null;
    origin: FootballGridOrigin;
    players: Array<{ userId: string; seat: 1 | 2; isBot?: boolean }>;
    openerUserId: string;
    seriesId?: string | null;
    rematchOfMatchId?: string | null;
    rematchIndex?: number;
    botReservationFence?: number | null;
    botRp?: number | null;
    botTier?: string | null;
    botModelVersion?: number | null;
    botConfigVersion?: number | null;
    botRngSeed?: number | null;
    afterCreateInTx?: (tx: TransactionSql, matchId: string) => Promise<void>;
  }): Promise<{ state: FootballGridState; created: boolean }> {
    try {
      return await footballGridRepo.createMatch({ ...input, lobbyId: input.lobbyId ?? null });
    } catch (error) {
      if (error instanceof Error && error.message === 'No published Football Grid board is available') {
        appMetrics.footballGridContentExhaustion.add(1, { origin: input.origin });
      }
      throw error;
    }
  },

  async getState(matchId: string, userId: string): Promise<FootballGridState> {
    const state = await currentOrThrow(matchId);
    if (!state.players.some((player) => player.userId === userId)) {
      throw new AuthorizationError('Not a Football Grid participant');
    }
    return state;
  },

  async acknowledgeHandoff(input: {
    matchId: string;
    userId: string;
    expectedStateVersion: number;
  }): Promise<FootballGridState> {
    try {
      const state = await footballGridRepo.runInTransaction(async (tx) => {
        const previous = await footballGridRepo.loadStateForUpdate(tx, input.matchId);
        if (!previous) throw new NotFoundError('Football Grid match not found');
        const existing = previous.players.find((player) => player.userId === input.userId);
        if (!existing) throw new AuthorizationError('Not a Football Grid participant');
        if (existing.handoffAcknowledged) return previous;
        if (previous.phase !== 'handoff') throw new ConflictError('Football Grid is no longer awaiting handoff');
        assertBarrierVersion(previous, input.userId, input.expectedStateVersion, 'handoff');
        const nowMs = await footballGridRepo.databaseNowMs(tx);
        const phaseDeadlineMs = Date.parse(previous.phaseDeadlineAt ?? '');
        if (Number.isFinite(phaseDeadlineMs) && nowMs > phaseDeadlineMs) {
          const next = cancelNoContest(previous, 'loading_no_show', nowMs);
          await footballGridRepo.persistStateInTx(tx, previous, next, {
            eventType: 'loading_no_show', eventPayload: { lateUserId: input.userId, phase: 'handoff' },
          });
          return next;
        }
        // Barrier acknowledgements commute: both clients legitimately receive
        // the same version, and either may acquire the row lock first. The
        // phase/participant checks above are the authority; a peer's ACK must
        // not make this participant's ACK stale.
        const next = acknowledgeHandoff(previous, input.userId, previous.stateVersion, nowMs);
        await footballGridRepo.persistStateInTx(tx, previous, next, {
          eventType: 'handoff_acknowledged', eventPayload: { userId: input.userId },
        });
        return next;
      });
      if (state.phase === 'terminal') invalidateBoardAnswerContent(input.matchId);
      return state;
    } catch (error) {
      throw toDomainError(error);
    }
  },

  async markReady(input: {
    matchId: string;
    userId: string;
    commandId: string;
    expectedStateVersion: number;
  }): Promise<FootballGridState> {
    try {
      return await footballGridRepo.runInTransaction(async (tx) => {
        const previous = await footballGridRepo.loadStateForUpdate(tx, input.matchId);
        if (!previous) throw new NotFoundError('Football Grid match not found');
        const existing = previous.players.find((player) => player.userId === input.userId);
        if (!existing) throw new AuthorizationError('Not a Football Grid participant');
        if (existing.ready) return previous;
        if (previous.phase !== 'loading') throw new ConflictError('Football Grid is no longer awaiting readiness');
        assertBarrierVersion(previous, input.userId, input.expectedStateVersion, 'ready');
        const nowMs = await footballGridRepo.databaseNowMs(tx);
        const phaseDeadlineMs = Date.parse(previous.phaseDeadlineAt ?? '');
        if (Number.isFinite(phaseDeadlineMs) && nowMs > phaseDeadlineMs) {
          const next = cancelNoContest(previous, 'loading_no_show', nowMs);
          await footballGridRepo.persistStateInTx(tx, previous, next, {
            eventType: 'loading_no_show', eventPayload: { lateUserId: input.userId, phase: 'loading' },
          });
          return next;
        }
        // Readiness is another two-party barrier and therefore commutes for
        // distinct participants while the match remains in `loading`.
        const next = markReady(previous, input.userId, previous.stateVersion, nowMs);
        await footballGridRepo.persistStateInTx(tx, previous, next, {
          eventType: 'client_ready', eventPayload: { userId: input.userId },
          readyCommand: { userId: input.userId, commandId: input.commandId },
        });
        return next;
      });
    } catch (error) {
      throw toDomainError(error);
    }
  },

  async submitAnswer(input: {
    matchId: string;
    userId: string;
    commandId: string;
    expectedStateVersion: number;
    cellIndex: number;
    text: string;
    locale: 'en' | 'ka';
  }): Promise<FootballGridCommandResult> {
    try {
      const inbox = await footballGridRepo.admitCommand({
        matchId: input.matchId,
        actorUserId: input.userId,
        commandId: input.commandId,
        expectedStateVersion: input.expectedStateVersion,
        commandType: 'answer',
        cellIndex: input.cellIndex,
        locale: input.locale,
        submittedText: input.text,
        payloadHash: commandPayloadHash({
          matchId: input.matchId,
          cellIndex: input.cellIndex,
          text: input.text,
          locale: input.locale,
          expectedStateVersion: input.expectedStateVersion,
        }),
      });
      return await processInbox(inbox);
    } catch (error) {
      throw toDomainError(error);
    }
  },

  async pass(input: {
    matchId: string;
    userId: string;
    commandId: string;
    expectedStateVersion: number;
  }): Promise<FootballGridCommandResult> {
    try {
      const inbox = await footballGridRepo.admitCommand({
        matchId: input.matchId,
        actorUserId: input.userId,
        commandId: input.commandId,
        expectedStateVersion: input.expectedStateVersion,
        commandType: 'pass',
        payloadHash: commandPayloadHash(input),
      });
      return await processInbox(inbox);
    } catch (error) {
      throw toDomainError(error);
    }
  },

  async forfeit(input: {
    matchId: string;
    userId: string;
    expectedStateVersion: number;
  }): Promise<FootballGridState> {
    try {
      return await footballGridRepo.runInTransaction(async (tx) => {
        const previous = await footballGridRepo.loadStateForUpdate(tx, input.matchId);
        if (!previous) throw new NotFoundError('Football Grid match not found');
        if (previous.phase === 'terminal') return previous;
        if (previous.stateVersion !== input.expectedStateVersion) throw new ConflictError('Stale Football Grid state');
        const next = forfeitMatch(previous, input.userId, 'forfeit', await footballGridRepo.databaseNowMs(tx));
        await footballGridRepo.persistStateInTx(tx, previous, next, {
          eventType: 'player_forfeited', eventPayload: { userId: input.userId },
        });
        return next;
      });
    } catch (error) {
      throw toDomainError(error);
    }
  },

  async handlePhaseDeadline(
    matchId: string,
    expectedStateVersion: number,
    presenceReconciled = false,
  ): Promise<{
    state: FootballGridState;
    deferred: boolean;
    turnResolution: { actorUserId: string; outcome: 'timeout' } | null;
  }> {
    const result = await footballGridRepo.runInTransaction(async (tx) => {
      const previous = await footballGridRepo.loadStateForUpdate(tx, matchId);
      if (!previous) throw new NotFoundError('Football Grid match not found');
      if (previous.phase === 'terminal' || previous.stateVersion !== expectedStateVersion) {
        return { state: previous, deferred: false, turnResolution: null };
      }
      const needsPresenceFence = previous.phase === 'countdown'
        || (
          previous.phase === 'turn'
          && previous.players.some((player) => !player.isBot && player.userId === previous.currentPlayerUserId)
        );
      if (needsPresenceFence && !presenceReconciled) {
        throw new InternalError('Football Grid deadline requires presence reconciliation');
      }
      const nowMs = await footballGridRepo.databaseNowMs(tx);
      const deadlineMs = Date.parse(previous.phaseDeadlineAt ?? '');
      if (Number.isFinite(deadlineMs) && deadlineMs > nowMs) {
        return { state: previous, deferred: true, turnResolution: null };
      }
      if (await footballGridRepo.getPendingCommandIdInTx(tx, matchId)) {
        return { state: previous, deferred: true, turnResolution: null };
      }
      let next: FootballGridState;
      let eventType: string;
      let turnResolution: { actorUserId: string; outcome: 'timeout' } | null = null;
      appMetrics.footballGridPhaseTimeouts.add(1, { phase: previous.phase });
      if (previous.phase === 'handoff' || previous.phase === 'loading') {
        next = cancelNoContest(previous, 'loading_no_show', nowMs);
        eventType = 'loading_no_show';
      } else if (previous.phase === 'countdown') {
        next = startTurnAfterCountdown(previous, previous.stateVersion, nowMs);
        eventType = 'turn_started';
      } else if (previous.phase === 'turn') {
        const actor = previous.currentPlayerUserId;
        const hadActivity = actor
          ? await footballGridRepo.hasTurnActivityInTx(tx, matchId, actor, previous.turnNumber)
          : false;
        next = expireTurn(previous, previous.stateVersion, nowMs, { hadActivity });
        eventType = next.phase === 'terminal'
          ? (next.completionReason === 'no_action_timeouts' ? 'no_action_forfeit' : 'turn_limit_reached')
          : 'turn_timeout';
        turnResolution = actor ? { actorUserId: actor, outcome: 'timeout' } : null;
      } else if (previous.phase === 'paused') {
        const absent = await footballGridRepo.listAbsentParticipantsInTx(tx, matchId);
        if (absent.length === 0) return { state: previous, deferred: false, turnResolution: null };
        if (absent.length === 2) {
          next = cancelNoContest(previous, 'simultaneous_disconnect', nowMs);
          eventType = 'simultaneous_disconnect';
        } else {
          next = forfeitMatch(previous, absent[0].userId, 'disconnect_timeout', nowMs);
          eventType = 'disconnect_forfeit';
        }
      } else if (previous.phase === 'service_interruption') {
        // The interruption pause carries its own deadline. If command recovery
        // has not resumed the match by now, end it cleanly rather than leaving
        // both players stranded until the stale-match sweeper acts.
        next = cancelNoContest(previous, 'administrative_cancel', nowMs);
        eventType = 'service_interruption_cancelled';
      } else {
        return { state: previous, deferred: false, turnResolution: null };
      }
      await footballGridRepo.persistStateInTx(tx, previous, next, { eventType });
      return { state: next, deferred: false, turnResolution };
    });
    if (result.state.phase === 'terminal') invalidateBoardAnswerContent(matchId);
    return result;
  },

  async reconcileDisconnected(matchId: string, userId: string, expectedPresenceGeneration?: number): Promise<{
    state: FootballGridState;
    deferred: boolean;
  }> {
    return footballGridRepo.runInTransaction(async (tx) => {
      const previous = await footballGridRepo.loadStateForUpdate(tx, matchId);
      if (!previous) throw new NotFoundError('Football Grid match not found');
      if (previous.phase === 'terminal') return { state: previous, deferred: false };
      // An already-admitted on-time command owns turn advancement. Do not even
      // mark DB absence until it commits, otherwise the pause version bump
      // would cancel that durable command as stale.
      if (await footballGridRepo.getPendingCommandIdInTx(tx, matchId)) {
        return { state: previous, deferred: true };
      }
      const nowMs = await footballGridRepo.databaseNowMs(tx);
      const presence = await footballGridRepo.markParticipantAbsentInTx(tx, matchId, userId, expectedPresenceGeneration);
      if (presence.changed) {
        appMetrics.footballGridPresenceTransitions.add(1, { transition: 'disconnected', phase: previous.phase });
      }
      // During the handoff/loading barriers the existing no-show deadline is
      // authoritative. Record absence for multi-socket correctness, but do not
      // replace that deadline with the in-game reconnect pause state.
      if (previous.phase === 'handoff' || previous.phase === 'loading') {
        return { state: previous, deferred: false };
      }
      if (!presence.changed && !presence.absentUserIds.includes(userId)) {
        return { state: previous, deferred: false };
      }
      if (!presence.changed && previous.status === 'paused') {
        return { state: previous, deferred: false };
      }
      const candidateDeadline = nowMs + Math.min(FOOTBALL_GRID_RECONNECT_MS, presence.userPauseBudgetMs);
      const next = previous.status === 'paused'
        ? shortenDisconnectPause(previous, candidateDeadline)
        : pauseForDisconnect(previous, nowMs, candidateDeadline);
      await footballGridRepo.persistStateInTx(tx, previous, next, {
        eventType: 'player_disconnected', eventPayload: { userId, absentCount: presence.absentUserIds.length },
      });
      return { state: next, deferred: false };
    });
  },

  async markDisconnected(matchId: string, userId: string, expectedPresenceGeneration?: number): Promise<FootballGridState> {
    return (await this.reconcileDisconnected(matchId, userId, expectedPresenceGeneration)).state;
  },

  async markReconnected(matchId: string, userId: string): Promise<FootballGridState> {
    return footballGridRepo.runInTransaction(async (tx) => {
      let previous = await footballGridRepo.loadStateForUpdate(tx, matchId);
      if (!previous) throw new NotFoundError('Football Grid match not found');
      if (previous.phase === 'terminal') return previous;
      const nowMs = await footballGridRepo.databaseNowMs(tx);
      const reconnectDeadlineMs = Date.parse(previous.reconnectDeadlineAt ?? previous.phaseDeadlineAt ?? '');
      if (
        previous.status === 'paused'
        && Number.isFinite(reconnectDeadlineMs)
        && nowMs > reconnectDeadlineMs
      ) {
        const absent = await footballGridRepo.listAbsentParticipantsInTx(tx, matchId);
        const next = absent.length === 2
          ? cancelNoContest(previous, 'simultaneous_disconnect', nowMs)
          : absent.length === 1
            ? forfeitMatch(previous, absent[0].userId, 'disconnect_timeout', nowMs)
            : previous;
        if (next !== previous) {
          await footballGridRepo.persistStateInTx(tx, previous, next, {
            eventType: absent.length === 2 ? 'simultaneous_disconnect' : 'disconnect_forfeit',
            eventPayload: { lateReconnectUserId: userId },
          });
        }
        return next;
      }
      const presence = await footballGridRepo.markParticipantPresentInTx(tx, matchId, userId);
      if (!presence.changed && previous.status !== 'paused') return previous;
      if (presence.changed) appMetrics.footballGridPresenceTransitions.add(1, { transition: 'reconnected', phase: previous.phase });
      previous = (await footballGridRepo.loadStateForUpdate(tx, matchId)) ?? previous;
      if (previous.phase === 'service_interruption') return previous;
      if (previous.status !== 'paused' || presence.absentUserIds.length > 0) return previous;
      const next = resumeAfterReconnect(previous, nowMs);
      await footballGridRepo.persistStateInTx(tx, previous, next, {
        eventType: 'match_resumed', eventPayload: { userId },
      });
      return next;
    });
  },

  async reportMissingAnswer(attemptId: string, userId: string): Promise<string> {
    try {
      return await footballGridRepo.reportMissingAnswer(attemptId, userId);
    } catch (error) {
      throw toDomainError(error);
    }
  },

  async cancelAdministratively(matchId: string): Promise<FootballGridState> {
    const state = await footballGridRepo.runInTransaction(async (tx) => {
      const previous = await footballGridRepo.loadStateForUpdate(tx, matchId);
      if (!previous) throw new NotFoundError('Football Grid match not found');
      if (previous.phase === 'terminal') return previous;
      const next = cancelNoContest(previous, 'administrative_cancel', await footballGridRepo.databaseNowMs(tx));
      await footballGridRepo.persistStateInTx(tx, previous, next, { eventType: 'administrative_cancel' });
      return next;
    });
    if (state.phase === 'terminal') invalidateBoardAnswerContent(matchId);
    return state;
  },

  /**
   * Atomic decision for a player re-entering matchmaking while an unfinished
   * match exists. Row-locks the match so a concurrent deadline advance cannot
   * turn an un-started bot match into a live one mid-cancel (and vice versa).
   */
  async resolveStaleMatchOnSearchStart(input: {
    matchId: string;
    userId: string;
  }): Promise<'cancelled' | 'resumable' | 'gone'> {
    return footballGridRepo.runInTransaction(async (tx) => {
      const previous = await footballGridRepo.loadStateForUpdate(tx, input.matchId);
      if (!previous || previous.phase === 'terminal') return 'gone';
      const opponent = previous.players.find((player) => player.userId !== input.userId);
      const notYetStarted = previous.phase === 'handoff'
        || previous.phase === 'loading'
        || previous.phase === 'countdown';
      if (!(notYetStarted && opponent?.isBot)) return 'resumable';
      const next = cancelNoContest(previous, 'administrative_cancel', await footballGridRepo.databaseNowMs(tx));
      await footballGridRepo.persistStateInTx(tx, previous, next, {
        eventType: 'administrative_cancel',
        eventPayload: { userId: input.userId, reason: 'abandoned_before_start' },
      });
      return 'cancelled';
    });
  },

  async recoverPendingCommand(inbox: FootballGridCommandInboxRow): Promise<FootballGridCommandResult> {
    return processInbox(inbox);
  },
};
