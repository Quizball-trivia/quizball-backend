import type { QuizballServer } from '../socket-server.js';
import type { LobbyChallengeStatusPayload } from '../socket.types.js';
import { logger } from '../../core/logger.js';
import { InternalError } from '../../core/errors.js';

/**
 * Module-local Socket.IO reference, set once at boot from
 * `socket-server.ts:initSocketServer`, so the bot challenge responder — a
 * background worker with no socket of its own — can deliver a decline to the
 * challenger's user room. Mirrors `notifications-realtime.service.ts`.
 */
let ioRef: QuizballServer | null = null;

export function setLobbyChallengeRealtimeServer(io: QuizballServer): void {
  if (!io) {
    throw new InternalError(
      'setLobbyChallengeRealtimeServer: QuizballServer instance must not be null/undefined'
    );
  }
  if (ioRef && ioRef !== io) {
    logger.warn('lobby-challenge-realtime server already initialized — overwriting reference');
  }
  ioRef = io;
}

/**
 * Best-effort: push a challenge status change to both parties' user rooms.
 *
 * Byte-identical in event name and payload shape to the human decline path
 * (`lobby-challenge.service.ts:emitChallengeStatus`) — a bot's decline must be
 * indistinguishable from a friend's on the wire. The bot side is emitted too,
 * costing nothing (a bot has no sockets), so the payload stays identical
 * rather than special-cased.
 */
export function emitLobbyChallengeStatus(
  payload: LobbyChallengeStatusPayload,
  fromUserId?: string
): void {
  if (!ioRef) return;
  try {
    ioRef.to(`user:${payload.toUserId}`).emit('lobby:challenge_status', payload);
    if (fromUserId) {
      ioRef.to(`user:${fromUserId}`).emit('lobby:challenge_status', payload);
    }
  } catch (err) {
    logger.warn({ err, invitationId: payload.invitationId }, 'Failed to emit lobby:challenge_status');
  }
}
