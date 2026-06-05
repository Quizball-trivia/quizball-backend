import crypto from 'crypto';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import {
  lobbyCreateSchema,
  lobbyChallengeDecisionSchema,
  lobbyChallengeSchema,
  lobbyJoinByCodeSchema,
  lobbyLeaveSchema,
  lobbyReadySchema,
  lobbyStartSchema,
  lobbyUpdateSettingsSchema,
} from '../schemas/lobby.schemas.js';
import { logger } from '../../core/logger.js';
import { trackLobbyCreated, trackLobbyJoined, trackLobbyLeft } from '../../core/analytics/game-events.js';
import { lobbyRealtimeService } from '../services/lobby-realtime.service.js';

function readCorrelationId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as { correlationId?: unknown }).correlationId;
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
}

function normalizeCorrelationId(payload: unknown): string {
  return readCorrelationId(payload) ?? `srv_${crypto.randomUUID()}`;
}

export function registerLobbyHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('lobby:create', async (payload, ack) => {
    const correlationId = normalizeCorrelationId(payload);
    const parsed = lobbyCreateSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ correlationId, errors: parsed.error.flatten() }, 'Invalid lobby:create payload');
      ack?.({
        ok: false,
        code: 'INVALID_LOBBY_CREATE',
        message: 'Invalid lobby create payload',
        retryable: false,
        correlationId,
      });
      return;
    }

    try {
      const result = await lobbyRealtimeService.createLobby(io, socket, {
        ...parsed.data,
        correlationId,
      });
      ack?.(result);
      if (result.ok && result.lobbyId) {
        trackLobbyCreated(socket.data.user.id, result.lobbyId, parsed.data.mode);
      }
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id, correlationId }, 'Error handling lobby:create');
      socket.emit('error', { code: 'LOBBY_CREATE_ERROR', message: 'Failed to create lobby' });
      ack?.({
        ok: false,
        code: 'LOBBY_CREATE_ERROR',
        message: 'Failed to create lobby',
        retryable: true,
        correlationId,
      });
    }
  });

  socket.on('lobby:challenge', async (payload) => {
    const parsed = lobbyChallengeSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:challenge payload');
      return;
    }

    try {
      await lobbyRealtimeService.challengeFriend(io, socket, parsed.data);
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id }, 'Error handling lobby:challenge');
      socket.emit('error', { code: 'LOBBY_CHALLENGE_ERROR', message: 'Failed to create challenge' });
    }
  });

  socket.on('lobby:challenge_accept', async (payload) => {
    const parsed = lobbyChallengeDecisionSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:challenge_accept payload');
      return;
    }

    try {
      await lobbyRealtimeService.acceptChallenge(io, socket, parsed.data);
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id }, 'Error handling lobby:challenge_accept');
      socket.emit('error', { code: 'LOBBY_CHALLENGE_ACCEPT_ERROR', message: 'Failed to accept challenge' });
    }
  });

  socket.on('lobby:challenge_decline', async (payload) => {
    const parsed = lobbyChallengeDecisionSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:challenge_decline payload');
      return;
    }

    try {
      await lobbyRealtimeService.declineChallenge(io, socket, parsed.data);
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id }, 'Error handling lobby:challenge_decline');
      socket.emit('error', { code: 'LOBBY_CHALLENGE_DECLINE_ERROR', message: 'Failed to decline challenge' });
    }
  });

  socket.on('lobby:join_by_code', async (payload, ack) => {
    const correlationId = normalizeCorrelationId(payload);
    const parsed = lobbyJoinByCodeSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ correlationId, errors: parsed.error.flatten() }, 'Invalid lobby:join_by_code payload');
      ack?.({
        ok: false,
        code: 'INVALID_INVITE',
        message: 'Invalid invite code',
        retryable: false,
        correlationId,
      });
      return;
    }

    try {
      const result = await lobbyRealtimeService.joinByCode(
        io,
        socket,
        parsed.data.inviteCode,
        correlationId
      );
      ack?.(result);
      if (result.ok) {
        trackLobbyJoined(socket.data.user.id, result.lobbyId, result.inviteCode);
      }
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id, correlationId }, 'Error handling lobby:join_by_code');
      socket.emit('error', { code: 'LOBBY_JOIN_ERROR', message: 'Failed to join lobby' });
      ack?.({
        ok: false,
        code: 'LOBBY_JOIN_ERROR',
        message: 'Failed to join lobby',
        retryable: true,
        correlationId,
      });
    }
  });

  socket.on('lobby:ready', async (payload) => {
    const parsed = lobbyReadySchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:ready payload');
      return;
    }

    try {
      await lobbyRealtimeService.setReady(io, socket, parsed.data.ready);
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id }, 'Error handling lobby:ready');
      socket.emit('error', { code: 'LOBBY_READY_ERROR', message: 'Failed to update ready state' });
    }
  });

  socket.on('lobby:update_settings', async (payload) => {
    const parsed = lobbyUpdateSettingsSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:update_settings payload');
      return;
    }

    try {
      await lobbyRealtimeService.updateSettings(io, socket, parsed.data);
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id }, 'Error handling lobby:update_settings');
      socket.emit('error', { code: 'LOBBY_SETTINGS_ERROR', message: 'Failed to update settings' });
    }
  });

  socket.on('lobby:start', async (payload) => {
    const parsed = lobbyStartSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:start payload');
      return;
    }

    try {
      await lobbyRealtimeService.startFriendlyMatch(io, socket, parsed.data.lobbyId);
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id }, 'Error handling lobby:start');
      socket.emit('error', { code: 'LOBBY_START_ERROR', message: 'Failed to start match' });
    }
  });

  socket.on('lobby:leave', async (payload, ack) => {
    const correlationId = normalizeCorrelationId(payload);
    const parsed = lobbyLeaveSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      logger.warn({ correlationId, errors: parsed.error.flatten() }, 'Invalid lobby:leave payload');
      ack?.({
        ok: false,
        code: 'LOBBY_LEAVE_ERROR',
        message: 'Invalid lobby leave payload',
        retryable: false,
        correlationId,
      });
      return;
    }

    try {
      const result = await lobbyRealtimeService.leaveLobby(io, socket, correlationId);
      if (result.ok && result.lobbyId) {
        trackLobbyLeft(socket.data.user.id, result.lobbyId, result.closed ? 'closed' : 'left');
      }
      ack?.(result);
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id, correlationId }, 'Error handling lobby:leave');
      socket.emit('error', { code: 'LOBBY_LEAVE_ERROR', message: 'Failed to leave lobby' });
      ack?.({
        ok: false,
        code: 'LOBBY_LEAVE_ERROR',
        message: 'Failed to leave lobby',
        retryable: true,
        correlationId,
      });
    }
  });
}
