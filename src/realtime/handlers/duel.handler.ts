import { z } from 'zod';
import { logger } from '../../core/logger.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { allowDuelOperation, type DuelOperation } from '../services/duel-rate-limit.service.js';
import { duelRealtimeService } from '../services/duel-realtime.service.js';

const matchId = z.string().uuid();
const locale = z.string().max(8).optional();
const readySchema = z.object({ matchId, locale });
const resyncSchema = z.object({ matchId, locale });
const commandSchema = z.object({ matchId, commandId: z.string().uuid(), command: z.unknown() }) as z.ZodType<{ matchId: string; commandId: string; command: unknown }>;
const forfeitSchema = z.object({ matchId, commandId: z.string().uuid() });

export function registerDuelHandlers(io: QuizballServer, socket: QuizballSocket): void {
  const on = <T>(event: string, schema: z.ZodType<T>, operation: DuelOperation, task: (data: T) => Promise<void>) => {
    socket.on(event as never, ((payload: unknown) => {
      void (async () => {
        // The budget is charged before validation, so malformed floods are bounded (and not logged) too.
        if (!(await allowDuelOperation(socket.data.user.id, operation))) {
          socket.emit('duel:error', { code: 'rate_limited', message: 'rate_limited' });
          return;
        }
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          logger.warn({ event, userId: socket.data.user.id }, 'Invalid duel payload');
          socket.emit('duel:error', { code: 'invalid_request', message: 'invalid_request' });
          return;
        }
        const id = (parsed.data as { matchId?: string }).matchId;
        await task(parsed.data).catch((error) => duelRealtimeService.emitError(socket, error, id));
      })().catch((error) => duelRealtimeService.emitError(socket, error));
    }) as never);
  };

  on('duel:ready', readySchema, 'command', (data) => duelRealtimeService.handleReady(io, socket, data));
  on('duel:command', commandSchema, 'command', (data) => duelRealtimeService.handleCommand(io, socket, data));
  on('duel:resync', resyncSchema, 'sync', (data) => duelRealtimeService.handleResync(io, socket, data));
  on('duel:forfeit', forfeitSchema, 'command', (data) => duelRealtimeService.handleForfeit(io, socket, data));
}
