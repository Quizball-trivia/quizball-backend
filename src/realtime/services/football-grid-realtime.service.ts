import { createHmac } from 'node:crypto';
import { AppError, ConflictError } from '../../core/errors.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { resolveTrustedClientIp } from '../../http/client-ip.js';
import { syntheticBotsRepo } from '../../modules/synthetic-bots/synthetic-bots.repo.js';
import {
  footballGridRepo,
  footballGridService,
  footballGridBotService,
  footballGridSettlementService,
  type FootballGridState,
} from '../../modules/football-grid/index.js';
import type { FootballGridResultDeliveryRow } from '../../modules/football-grid/football-grid.repo.js';
import {
  cancelRealtimeTimer,
  scheduleRealtimeTimer,
  type RealtimeTimerPayload,
} from '../realtime-timer-scheduler.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type {
  FootballGridSubmitAnswerPayload,
  FootballGridVersionedCommandPayload,
} from '../socket.types.js';
import { footballGridPresenceService } from './football-grid-presence.service.js';
import { transitionFootballGridSocket } from '../football-grid-socket-transition.js';

const GRID_TIMER_KIND = 'football_grid_phase' as const;
const GRID_BOT_TIMER_KIND = 'football_grid_bot_action' as const;
let recoveryTimer: NodeJS.Timeout | null = null;
let recoveryRunning = false;

function gridRoom(matchId: string): string {
  return `grid:${matchId}`;
}

function riskSignalHash(kind: 'device' | 'network', value: string | null): string | null {
  const secret = config.FOOTBALL_GRID_RISK_HASH_SECRET?.trim();
  if (!secret || !value?.trim()) return null;
  return createHmac('sha256', secret).update(`${kind}:${value.trim()}`).digest('hex');
}

function gridError(error: unknown): { code: string; message: string; meta?: Record<string, unknown> } {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details && typeof error.details === 'object'
        ? { meta: error.details as Record<string, unknown> }
        : {}),
    };
  }
  return { code: 'GRID_INTERNAL_ERROR', message: 'Football Grid request failed' };
}

async function scheduleStateDeadline(state: FootballGridState): Promise<void> {
  if (state.phase === 'terminal' || !state.phaseDeadlineAt) {
    await Promise.all([
      cancelRealtimeTimer(GRID_TIMER_KIND, state.matchId),
      cancelRealtimeTimer(GRID_BOT_TIMER_KIND, state.matchId),
    ]);
    return;
  }
  const botRuntime = await footballGridRepo.getBotRuntime(state.matchId);
  if (botRuntime) {
    await syntheticBotsRepo.heartbeatReservationFenced({
      botUserId: botRuntime.botUserId,
      expectedFence: botRuntime.reservationFence,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
  }
  await scheduleRealtimeTimer(
    GRID_TIMER_KIND,
    state.matchId,
    new Date(state.phaseDeadlineAt),
    { kind: GRID_TIMER_KIND, matchId: state.matchId, expectedStateVersion: state.stateVersion },
  );
  const botSchedule = await footballGridBotService.getSchedule(state.matchId, state);
  if (!botSchedule) {
    await cancelRealtimeTimer(GRID_BOT_TIMER_KIND, state.matchId);
    return;
  }
  const turnDeadlineMs = Date.parse(state.turnDeadlineAt ?? '');
  const dueAtMs = Math.min(
    Date.now() + botSchedule.delayMs,
    Number.isFinite(turnDeadlineMs) ? turnDeadlineMs - 500 : Date.now() + botSchedule.delayMs,
  );
  const durableDueAt = await footballGridRepo.ensureBotActionDeadline({
    matchId: state.matchId,
    botUserId: state.currentPlayerUserId!,
    expectedStateVersion: botSchedule.expectedStateVersion,
    proposedDeadlineAt: new Date(Math.max(Date.now(), dueAtMs)).toISOString(),
  });
  if (!durableDueAt) return;
  await scheduleRealtimeTimer(
    GRID_BOT_TIMER_KIND,
    state.matchId,
    new Date(durableDueAt),
    {
      kind: GRID_BOT_TIMER_KIND,
      matchId: state.matchId,
      expectedStateVersion: botSchedule.expectedStateVersion,
      turnNumber: botSchedule.turnNumber,
    },
  );
}

async function emitState(io: QuizballServer, state: FootballGridState): Promise<void> {
  const payload = { matchId: state.matchId, state, serverNow: new Date().toISOString() };
  io.to(gridRoom(state.matchId)).emit('grid:state', payload);
  if (state.phase === 'loading' || state.phase === 'handoff') {
    io.to(gridRoom(state.matchId)).emit('grid:loading_state', payload);
  }
  if (state.phase === 'countdown' && state.phaseDeadlineAt) {
    io.to(gridRoom(state.matchId)).emit('grid:countdown', {
      ...payload,
      countdownEndsAt: state.phaseDeadlineAt,
    });
  }
  if (state.phase === 'paused' || state.phase === 'service_interruption') {
    io.to(gridRoom(state.matchId)).emit('grid:paused', payload);
  }
  if (state.phase === 'terminal') {
    const deliveries = await footballGridRepo.claimPendingResultDeliveries({ matchId: state.matchId });
    await processTerminalDeliveries(io, state, deliveries);
  }
}

async function processTerminalDeliveries(
  io: QuizballServer,
  state: FootballGridState,
  deliveries: FootballGridResultDeliveryRow[],
): Promise<void> {
  if (state.phase !== 'terminal' || deliveries.length === 0) return;

  // This order is deliberate: the rematch window and settlement are durable
  // before any participant delivery can be acknowledged. A process crash can
  // therefore only leave retryable delivery rows, never a client-visible
  // completion without its corresponding durable result/rematch state.
  const rematchWindow = await footballGridRepo.openRematchWindow(state.matchId);
  if (rematchWindow) {
    await scheduleRealtimeTimer(
      'football_grid_rematch_expiry',
      rematchWindow.seriesId,
      new Date(rematchWindow.expiresAt),
      {
        kind: 'football_grid_rematch_expiry',
        seriesId: rematchWindow.seriesId,
        expectedSeriesVersion: rematchWindow.seriesVersion,
      },
    );
  }
  const rewards = await footballGridSettlementService.settleMatch(state.matchId);
  const humanDeliveries = deliveries.filter((delivery) =>
    state.players.some((player) => player.userId === delivery.user_id && !player.isBot));
  if (humanDeliveries.some((delivery) => !rewards.has(delivery.user_id))) {
    await Promise.all(humanDeliveries.map((delivery) => footballGridRepo.deferResultDelivery({
      matchId: delivery.match_id,
      userId: delivery.user_id,
      terminalStateVersion: delivery.terminal_state_version,
      ackToken: delivery.ack_token,
      reason: 'settlement_not_ready',
    })));
    return;
  }

  const [samples, rematch] = await Promise.all([
    footballGridRepo.getCuratedResultSamples(state.matchId),
    footballGridRepo.getRematchInfo(state.matchId),
  ]);
  const payload = { matchId: state.matchId, state, serverNow: new Date().toISOString() };
  for (const delivery of humanDeliveries) {
    try {
      const sockets = await io.in(`user:${delivery.user_id}`).fetchSockets();
      if (sockets.length === 0) {
        await footballGridRepo.deferResultDelivery({
          matchId: delivery.match_id,
          userId: delivery.user_id,
          terminalStateVersion: delivery.terminal_state_version,
          ackToken: delivery.ack_token,
          reason: 'participant_offline',
        });
        continue;
      }
      // Arm the exact delivery attempt before exposing its unpredictable ACK
      // token. A terminal grid:state contains the state version but can never
      // acknowledge or suppress a result payload that has not been emitted.
      const armed = await footballGridRepo.awaitResultDeliveryAck(
        delivery.match_id,
        delivery.user_id,
        delivery.terminal_state_version,
        delivery.ack_token,
      );
      if (!armed) continue;
      io.to(`user:${delivery.user_id}`).emit('grid:completed', {
        ...payload,
        terminalStateVersion: delivery.terminal_state_version,
        ackToken: delivery.ack_token,
        samples,
        rewards: rewards.get(delivery.user_id)!,
        rematch,
      });
    } catch (error) {
      await footballGridRepo.deferResultDelivery({
        matchId: delivery.match_id,
        userId: delivery.user_id,
        terminalStateVersion: delivery.terminal_state_version,
        ackToken: delivery.ack_token,
        reason: error instanceof Error ? error.message : 'terminal_delivery_failed',
      }).catch(() => {});
      logger.warn({ error, matchId: state.matchId, userId: delivery.user_id }, 'Football Grid result delivery failed');
    }
  }
}

async function recoverTerminalResultDeliveries(
  io: QuizballServer,
  matchId: string | null = null,
): Promise<number> {
  let processed = 0;
  while (true) {
    const deliveries = await footballGridRepo.claimPendingResultDeliveries({ matchId, limit: 100 });
    if (deliveries.length === 0) break;
    const byMatch = new Map<string, FootballGridResultDeliveryRow[]>();
    for (const delivery of deliveries) {
      const current = byMatch.get(delivery.match_id) ?? [];
      current.push(delivery);
      byMatch.set(delivery.match_id, current);
    }
    for (const [claimedMatchId, claimed] of byMatch) {
      const state = await footballGridRepo.loadState(claimedMatchId);
      if (!state || state.phase !== 'terminal') {
        await Promise.all(claimed.map((delivery) => footballGridRepo.deferResultDelivery({
          matchId: delivery.match_id,
          userId: delivery.user_id,
          terminalStateVersion: delivery.terminal_state_version,
          ackToken: delivery.ack_token,
          reason: 'terminal_state_unavailable',
        })));
        continue;
      }
      await processTerminalDeliveries(io, state, claimed);
      processed += claimed.length;
    }
    if (deliveries.length < 100 || matchId !== null) break;
  }
  return processed;
}

function emitTurnResolved(io: QuizballServer, input: {
  state: FootballGridState;
  actorUserId: string;
  outcome: 'correct' | 'wrong' | 'already_used' | 'pass' | 'timeout';
  cellIndex: number | null;
  resolvedPlayerId: string | null;
}): void {
  io.to(gridRoom(input.state.matchId)).emit('grid:turn_resolved', {
    matchId: input.state.matchId,
    state: input.state,
    serverNow: new Date().toISOString(),
    actorUserId: input.actorUserId,
    outcome: input.outcome,
    cellIndex: input.cellIndex,
    resolvedPlayerId: input.outcome === 'correct' ? input.resolvedPlayerId : null,
  });
}

async function applyAndBroadcast(
  io: QuizballServer,
  operation: () => Promise<FootballGridState>,
): Promise<FootballGridState> {
  const state = await operation();
  await scheduleStateDeadline(state);
  await emitState(io, state);
  return state;
}

async function publishServiceInterruptionIfNeeded(io: QuizballServer, matchId: string): Promise<void> {
  const state = await footballGridRepo.loadState(matchId);
  if (state?.phase !== 'service_interruption') return;
  await scheduleStateDeadline(state);
  await emitState(io, state);
}

export const footballGridRealtimeService = {
  async recoverTerminalDeliveries(io: QuizballServer, matchId?: string): Promise<number> {
    return recoverTerminalResultDeliveries(io, matchId ?? null);
  },

  async publishState(io: QuizballServer, state: FootballGridState): Promise<void> {
    await scheduleStateDeadline(state);
    await emitState(io, state);
  },

  async rearmActiveMatches(): Promise<void> {
    let cursor: string | null = null;
    while (true) {
      const matchIds = await footballGridRepo.listNonterminalMatchIds(500, cursor);
      for (const matchId of matchIds) {
        const state = await footballGridRepo.loadState(matchId);
        if (state) await scheduleStateDeadline(state);
      }
      if (matchIds.length < 500) return;
      cursor = matchIds[matchIds.length - 1];
    }
  },

  startCommandRecovery(io: QuizballServer): void {
    if (recoveryTimer) return;
    const runRecovery = async () => {
      if (recoveryRunning) return;
      recoveryRunning = true;
      try {
        const exhaustedMatchIds = await footballGridRepo.finalizeExpiredExhaustedCommands();
        for (const matchId of exhaustedMatchIds) {
          await publishServiceInterruptionIfNeeded(io, matchId).catch((error) => {
            logger.warn({ error, matchId }, 'Football Grid exhausted-command pause delivery failed');
          });
        }
        const commands = await footballGridRepo.listRecoverableCommands();
        for (const command of commands) {
          try {
            const result = await footballGridService.recoverPendingCommand(command);
            await scheduleStateDeadline(result.state);
            await emitState(io, result.state);
          } catch (error) {
            logger.warn({ error, commandInboxId: command.id }, 'Football Grid command recovery attempt failed');
            await publishServiceInterruptionIfNeeded(io, command.match_id).catch(() => {});
          }
        }
        // Postgres is the durable fallback for every Grid deadline. This poll
        // continuously repairs lost Redis ZSET members, including after a
        // Redis restart that happens long after application boot.
        const duePhases = await footballGridRepo.listDuePhaseDeadlines();
        for (const due of duePhases) {
          await footballGridRealtimeService.handlePhaseTimer(io, {
              kind: GRID_TIMER_KIND,
              matchId: due.matchId,
              expectedStateVersion: due.stateVersion,
            })
            .catch((error) => logger.warn({ error, matchId: due.matchId }, 'Football Grid DB phase fallback failed'));
        }
        const dueBotActions = await footballGridRepo.listDueBotActionDeadlines();
        for (const due of dueBotActions) {
          await footballGridRealtimeService.handleBotActionTimer(io, {
              kind: GRID_BOT_TIMER_KIND,
              matchId: due.matchId,
              expectedStateVersion: due.stateVersion,
              turnNumber: due.turnNumber,
            })
            .catch((error) => logger.warn({ error, matchId: due.matchId }, 'Football Grid DB bot fallback failed'));
        }
        // Match creation is committed before network delivery. Redeliver every
        // still-unacknowledged handoff so a crashed starter cannot strand it.
        let handoffCursor: string | null = null;
        while (true) {
          const pendingHandoffs = await footballGridRepo.listPendingHandoffMatchIds(100, handoffCursor);
          for (const matchId of pendingHandoffs) {
            const state = await footballGridRepo.loadState(matchId);
            if (state) {
              await footballGridRealtimeService.emitMatchFound(io, state)
                .catch((error) => logger.warn({ error, matchId }, 'Football Grid handoff redelivery failed'));
            }
          }
          if (pendingHandoffs.length < 100) break;
          handoffCursor = pendingHandoffs[pendingHandoffs.length - 1];
        }

        // Terminal result delivery is its own durable outbox. Claiming with
        // SKIP LOCKED makes this safe across replicas, and repeated batches
        // prevent an offline oldest participant from starving a burst behind
        // it. Offline rows receive a short retry time before becoming due.
        await recoverTerminalResultDeliveries(io).catch((error) => {
          logger.warn({ error }, 'Football Grid terminal recovery failed');
        });
      } finally {
        recoveryRunning = false;
      }
    };
    recoveryTimer = setInterval(() => void runRecovery().catch(() => {}), 1_000);
    recoveryTimer.unref?.();
    void runRecovery().catch(() => {});
  },
  emitError(socket: QuizballSocket, error: unknown): void {
    const payload = gridError(error);
    logger.warn({ error, userId: socket.data.user.id, code: payload.code }, 'Football Grid realtime command failed');
    socket.emit('grid:error', payload);
  },

  async emitMatchFound(io: QuizballServer, state: FootballGridState): Promise<void> {
    const users = await usersRepo.getByIds(state.players.map((player) => player.userId));
    for (const player of state.players) {
      const opponent = state.players.find((candidate) => candidate.userId !== player.userId)!;
      const opponentUser = users.get(opponent.userId);
      const playerSockets = await io.in(`user:${player.userId}`).fetchSockets();
      const observationSocket = playerSockets[0];
      if (!player.isBot && observationSocket) {
        const rawDevice = observationSocket.handshake.headers['x-client-instance-id'];
        const deviceId = Array.isArray(rawDevice) ? rawDevice[0] : rawDevice;
        const trustedClientIp = resolveTrustedClientIp({
          headers: observationSocket.handshake.headers,
          socket: { remoteAddress: observationSocket.handshake.address },
        } as never);
        await footballGridRepo.recordRewardRiskObservation({
          matchId: state.matchId,
          userId: player.userId,
          deviceHash: riskSignalHash('device', typeof deviceId === 'string' ? deviceId : null),
          networkHash: riskSignalHash('network', trustedClientIp ?? null),
          source: 'socket_handoff',
        });
      }
      for (const playerSocket of playerSockets) {
        await transitionFootballGridSocket(io, {
          socketId: playerSocket.id,
          matchId: state.matchId,
          clearLobby: true,
        });
        await footballGridPresenceService.touch(state.matchId, player.userId, playerSocket.id);
      }
      io.to(`user:${player.userId}`).emit('grid:match_found', {
        matchId: state.matchId,
        state,
        opponent: {
          id: opponent.userId,
          username: opponentUser?.nickname ?? 'Player',
          avatarUrl: opponentUser?.avatar_url ?? null,
        },
        capabilities: {
          canAddFriend: !opponent.isBot,
          canChallenge: !opponent.isBot,
        },
        serverNow: new Date().toISOString(),
      });
    }
    await scheduleStateDeadline(state);
  },

  async handleHandoffAck(
    io: QuizballServer,
    socket: QuizballSocket,
    input: FootballGridVersionedCommandPayload,
  ): Promise<void> {
    // Authorize before joining the private match room. Socket.IO does not
    // roll back a room join when the later service call rejects.
    await footballGridService.getState(input.matchId, socket.data.user.id);
    await socket.join(gridRoom(input.matchId));
    socket.data.matchId = input.matchId;
    socket.data.gridMatchId = input.matchId;
    await footballGridPresenceService.touch(input.matchId, socket.data.user.id, socket.id);
    await footballGridService.markReconnected(input.matchId, socket.data.user.id);
    await applyAndBroadcast(io, () => footballGridService.acknowledgeHandoff({
      matchId: input.matchId,
      userId: socket.data.user.id,
      expectedStateVersion: input.expectedStateVersion,
    }));
  },

  async handleReady(
    io: QuizballServer,
    socket: QuizballSocket,
    input: FootballGridVersionedCommandPayload,
  ): Promise<void> {
    await footballGridService.getState(input.matchId, socket.data.user.id);
    await footballGridPresenceService.touch(input.matchId, socket.data.user.id, socket.id);
    await footballGridService.markReconnected(input.matchId, socket.data.user.id);
    await applyAndBroadcast(io, () => footballGridService.markReady({
      matchId: input.matchId,
      userId: socket.data.user.id,
      commandId: input.commandId,
      expectedStateVersion: input.expectedStateVersion,
    }));
  },

  async handleAnswer(
    io: QuizballServer,
    socket: QuizballSocket,
    input: FootballGridSubmitAnswerPayload,
  ): Promise<void> {
    let result: Awaited<ReturnType<typeof footballGridService.submitAnswer>>;
    try {
      result = await footballGridService.submitAnswer({
        ...input,
        userId: socket.data.user.id,
      });
    } catch (error) {
      await publishServiceInterruptionIfNeeded(io, input.matchId).catch(() => {});
      throw error;
    }
    socket.emit('grid:command_result', {
      matchId: input.matchId,
      commandId: input.commandId,
      outcome: result.outcome,
      stateVersion: result.state.stateVersion,
      resolvedPlayerId: result.resolvedPlayerId,
      attemptId: result.attemptId,
      duplicate: result.duplicate,
    });
    await scheduleStateDeadline(result.state);
    if (!result.duplicate && result.outcome !== 'ambiguous') {
      emitTurnResolved(io, {
        state: result.state,
        actorUserId: socket.data.user.id,
        outcome: result.outcome,
        cellIndex: input.cellIndex,
        resolvedPlayerId: result.resolvedPlayerId,
      });
    }
    await emitState(io, result.state);
  },

  async handlePass(
    io: QuizballServer,
    socket: QuizballSocket,
    input: FootballGridVersionedCommandPayload,
  ): Promise<void> {
    let result: Awaited<ReturnType<typeof footballGridService.pass>>;
    try {
      result = await footballGridService.pass({ ...input, userId: socket.data.user.id });
    } catch (error) {
      await publishServiceInterruptionIfNeeded(io, input.matchId).catch(() => {});
      throw error;
    }
    socket.emit('grid:command_result', {
      matchId: input.matchId,
      commandId: input.commandId,
      outcome: result.outcome,
      stateVersion: result.state.stateVersion,
      resolvedPlayerId: null,
      attemptId: result.attemptId,
      duplicate: result.duplicate,
    });
    await scheduleStateDeadline(result.state);
    if (!result.duplicate) {
      emitTurnResolved(io, {
        state: result.state,
        actorUserId: socket.data.user.id,
        outcome: 'pass',
        cellIndex: null,
        resolvedPlayerId: null,
      });
    }
    await emitState(io, result.state);
  },

  async handleResync(io: QuizballServer, socket: QuizballSocket, matchId: string): Promise<void> {
    const previous = await footballGridService.getState(matchId, socket.data.user.id);
    await socket.join(gridRoom(matchId));
    socket.data.matchId = matchId;
    socket.data.gridMatchId = matchId;
    await footballGridPresenceService.touch(matchId, socket.data.user.id, socket.id);
    const state = previous.phase === 'terminal'
      ? await footballGridService.markReconnected(matchId, socket.data.user.id)
      : await applyAndBroadcast(
          io,
          () => footballGridService.markReconnected(matchId, socket.data.user.id),
        );
    if (
      (previous.phase === 'paused' || previous.phase === 'service_interruption')
      && state.phase !== 'paused'
      && state.phase !== 'service_interruption'
    ) {
      io.to(gridRoom(matchId)).emit('grid:resumed', {
        matchId,
        state,
        serverNow: new Date().toISOString(),
      });
    }
    socket.emit('grid:state', { matchId, state, serverNow: new Date().toISOString() });
    if (state.phase === 'terminal') {
      // A reconnect must rebuild the complete result payload even if a prior
      // server emit happened just before the transport disconnected. Receipt
      // is durable only after `grid:completed_ack`.
      await footballGridRepo.makeResultDeliveryDue(matchId, socket.data.user.id);
      await recoverTerminalResultDeliveries(io, matchId);
    }
  },

  async handleCompletedAck(
    socket: QuizballSocket,
    input: { matchId: string; terminalStateVersion: number; ackToken: string },
  ): Promise<void> {
    await footballGridService.getState(input.matchId, socket.data.user.id);
    const acknowledged = await footballGridRepo.acknowledgeResultDelivery(
      input.matchId,
      socket.data.user.id,
      input.terminalStateVersion,
      input.ackToken,
    );
    if (!acknowledged) {
      throw new ConflictError('Football Grid result acknowledgement is invalid', {
        gridCode: 'COMPLETION_ACK_INVALID',
      });
    }
    socket.data.gridMatchId = undefined;
    if (socket.data.matchId === input.matchId) socket.data.matchId = undefined;
    await socket.leave(gridRoom(input.matchId));
  },

  async handleForfeit(
    io: QuizballServer,
    socket: QuizballSocket,
    input: FootballGridVersionedCommandPayload,
  ): Promise<void> {
    const state = await applyAndBroadcast(io, () => footballGridService.forfeit({
      matchId: input.matchId,
      userId: socket.data.user.id,
      expectedStateVersion: input.expectedStateVersion,
    }));
    if (state.phase === 'terminal') {
      socket.data.gridMatchId = undefined;
      socket.data.matchId = undefined;
    }
  },

  async handleReport(socket: QuizballSocket, attemptId: string): Promise<void> {
    const reportId = await footballGridService.reportMissingAnswer(attemptId, socket.data.user.id);
    socket.emit('grid:report_received', { reportId, attemptId });
  },

  async handlePresenceHeartbeat(socket: QuizballSocket, matchId: string): Promise<void> {
    const previous = await footballGridService.getState(matchId, socket.data.user.id);
    if (socket.data.gridMatchId !== matchId) {
      throw new ConflictError('Socket is not bound to this Football Grid match', {
        gridCode: 'GRID_MATCH_BINDING_MISMATCH',
      });
    }
    await footballGridPresenceService.touch(matchId, socket.data.user.id, socket.id);
    const state = await footballGridService.markReconnected(matchId, socket.data.user.id);
    await scheduleStateDeadline(state);
    if (state.stateVersion !== previous.stateVersion) {
      const io = socket.nsp.server as QuizballServer;
      await emitState(io, state);
      if (previous.phase === 'paused' && state.phase !== 'paused') {
        io.to(gridRoom(matchId)).emit('grid:resumed', {
          matchId,
          state,
          serverNow: new Date().toISOString(),
        });
      }
    }
  },

  async handlePhaseTimer(io: QuizballServer, payload: RealtimeTimerPayload): Promise<void> {
    if (payload.kind !== GRID_TIMER_KIND) return;
    const snapshot = await footballGridRepo.loadState(payload.matchId);
    if (!snapshot || snapshot.phase === 'terminal' || snapshot.stateVersion !== payload.expectedStateVersion) return;
    const presenceUsers = snapshot.phase === 'turn'
      ? snapshot.players.filter((player) => !player.isBot && player.userId === snapshot.currentPlayerUserId)
      : snapshot.phase === 'countdown'
        ? snapshot.players.filter((player) => !player.isBot)
        : [];
    for (const player of presenceUsers) {
      const presence = await footballGridPresenceService.reconcile(
        snapshot.matchId,
        player.userId,
        null,
        (generation) => footballGridService.reconcileDisconnected(snapshot.matchId, player.userId, generation),
      );
      if (presence.status === 'indeterminate') {
        await scheduleRealtimeTimer(GRID_TIMER_KIND, payload.matchId, new Date(Date.now() + 250), payload);
        return;
      }
      if (presence.status === 'absent') {
        if (presence.value.deferred) {
          await scheduleRealtimeTimer(
            'football_grid_presence_expiry',
            `${snapshot.matchId}:${player.userId}`,
            new Date(Date.now() + 250),
            {
              kind: 'football_grid_presence_expiry',
              matchId: snapshot.matchId,
              userId: player.userId,
              expectedPresenceGeneration: presence.generation,
            },
          );
          return;
        }
        await scheduleStateDeadline(presence.value.state);
        await emitState(io, presence.value.state);
        return;
      }
    }
    const result = await footballGridService.handlePhaseDeadline(
      payload.matchId,
      payload.expectedStateVersion,
      true,
    );
    if (result.deferred && result.state.phaseDeadlineAt) {
      await scheduleRealtimeTimer(
        GRID_TIMER_KIND,
        payload.matchId,
        new Date(Date.now() + 250),
        payload,
      );
      return;
    }
    await scheduleStateDeadline(result.state);
    if (result.turnResolution) {
      emitTurnResolved(io, {
        state: result.state,
        actorUserId: result.turnResolution.actorUserId,
        outcome: result.turnResolution.outcome,
        cellIndex: null,
        resolvedPlayerId: null,
      });
    }
    await emitState(io, result.state);
  },

  async handleBotActionTimer(io: QuizballServer, payload: RealtimeTimerPayload): Promise<void> {
    if (payload.kind !== GRID_BOT_TIMER_KIND) return;
    const result = await footballGridBotService.performTurn(payload);
    if (!result.changed) return;
    await scheduleStateDeadline(result.state);
    if (result.actorUserId && result.outcome) {
      emitTurnResolved(io, {
        state: result.state,
        actorUserId: result.actorUserId,
        outcome: result.outcome,
        cellIndex: result.cellIndex,
        resolvedPlayerId: result.resolvedPlayerId,
      });
    }
    await emitState(io, result.state);
  },

  async handlePresenceExpiryTimer(io: QuizballServer, payload: RealtimeTimerPayload): Promise<void> {
    if (payload.kind !== 'football_grid_presence_expiry') return;
    const result = await footballGridPresenceService.reconcile(
      payload.matchId,
      payload.userId,
      payload.expectedPresenceGeneration,
      (generation) => footballGridService.reconcileDisconnected(payload.matchId, payload.userId, generation),
    );
    if (result.status !== 'absent') return;
    if (result.value.deferred) {
      await scheduleRealtimeTimer(
        'football_grid_presence_expiry',
        `${payload.matchId}:${payload.userId}`,
        new Date(Date.now() + 250),
        payload,
      );
      return;
    }
    const state = result.value.state;
    await scheduleStateDeadline(state);
    await emitState(io, state);
    if (state.phase === 'terminal') await cancelRealtimeTimer(GRID_BOT_TIMER_KIND, state.matchId);
  },

  async handleSocketDisconnect(_io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const matchId = socket.data.gridMatchId;
    if (!matchId) return;
    await footballGridPresenceService.detach(matchId, socket.data.user.id, socket.id);
  },
};
