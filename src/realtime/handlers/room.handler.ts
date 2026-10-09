import { z } from 'zod';
import { logger } from '../../core/logger.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { allowDuelOperation, type DuelOperation } from '../services/duel-rate-limit.service.js';
import { roomRealtimeService } from '../services/room-realtime.service.js';

const matchId = z.string().uuid();
const locale = z.string().max(8).optional();
/** The room games this client can draw. */
const games = z.array(z.string().max(32)).max(16).optional();
const readySchema = z.object({ matchId, locale, games });
const resyncSchema = z.object({ matchId, locale, games });
const commandSchema = z.object({ matchId, commandId: z.string().uuid(), command: z.unknown() }) as z.ZodType<{ matchId: string; commandId: string; command: unknown }>;
const leaveSchema = z.object({ matchId, commandId: z.string().uuid() });
const reportSchema = z.object({ matchId, round: z.number().int().min(0).max(63), text: z.string().max(60).regex(/[\p{L}\p{N}]/u) });

export function registerRoomHandlers(io: QuizballServer, socket: QuizballSocket): void {
  const on = <T>(event: string, schema: z.ZodType<T>, operation: DuelOperation, task: (data: T) => Promise<void>) => {
    socket.on(event as never, ((payload: unknown) => {
      void (async () => {
        if (!(await allowDuelOperation(socket.data.user.id, operation, 'room'))) {
          socket.emit('room:error', { code: 'rate_limited', message: 'rate_limited' });
          return;
        }
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          logger.warn({ event, userId: socket.data.user.id }, 'Invalid room payload');
          socket.emit('room:error', { code: 'invalid_request', message: 'invalid_request' });
          return;
        }
        // room:pointer carries no payload (parsed.data is undefined).
        const id = (parsed.data as { matchId?: string } | undefined)?.matchId;
        // The gameplay DB limiter wraps only the service's writes (not reads or the broadcast after them).
        await task(parsed.data).catch((error) => roomRealtimeService.emitError(socket, error, id));
      })().catch((error) => roomRealtimeService.emitError(socket, error));
    }) as never);
  };

  on('room:ready', readySchema, 'command', (data) => roomRealtimeService.handleReady(io, socket, data));
  on('room:command', commandSchema, 'command', (data) => roomRealtimeService.handleCommand(io, socket, data));
  on('room:resync', resyncSchema, 'sync', (data) => roomRealtimeService.handleResync(io, socket, data));
  on('room:leave', leaveSchema, 'command', (data) => roomRealtimeService.handleLeave(io, socket, data));
  on('room:report', reportSchema, 'report', (data) => roomRealtimeService.handleReport(socket, data));
  on('room:pointer', z.object({}).strict().optional() as z.ZodType<unknown>, 'sync', () => roomRealtimeService.handlePointer(socket));
}
