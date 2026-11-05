import { z } from 'zod';
import { logger } from '../../core/logger.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { zoneMatchMatchmakingService } from '../services/zone-match-matchmaking.service.js';
import { allowDuelOperation, type DuelOperation } from '../services/duel-rate-limit.service.js';
import { socketIpBucket } from '../socket-auth.js';

/** Zone match (Ranked 2.0 beta) queue events; the match itself runs on the ordinary room:* pipeline. */

/** '*' cancels whatever search the user has (a screen that left before its searching ack knows no id). */
const searchCancelSchema = z.object({ searchId: z.string().min(1).max(64) }).strict();

function run(socket: QuizballSocket, event: string, operation: () => Promise<void>): void {
  void operation().catch((error) => {
    logger.error({ error, event, userId: socket.data.user.id }, 'Zone match socket handler failed');
    socket.emit('error', { code: 'ZONE_QUEUE_ERROR', message: 'Ranked 2.0 search failed. Please retry.' });
  });
}

function runLimited(socket: QuizballSocket, event: string, operation: DuelOperation, task: () => Promise<void>): void {
  run(socket, event, async () => {
    if (!(await allowDuelOperation(socket.data.user.id, operation, 'room'))) {
      socket.emit('error', { code: 'ZONE_RATE_LIMITED', message: 'Too many requests. Please slow down.' });
      return;
    }
    await task();
  });
}

export function registerZoneMatchHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('zone:search_start', () => {
    // 'start' per user plus the per-IP start budget: fresh guest identities share the IP bucket, so a join/leave
    // loop cannot mint bot users faster than an ordinary room start could.
    runLimited(socket, 'zone:search_start', 'start', async () => {
      if (!(await allowDuelOperation(socketIpBucket(socket), 'start_ip', 'room'))) {
        socket.emit('error', { code: 'ZONE_RATE_LIMITED', message: 'Too many requests. Please slow down.' });
        return;
      }
      await zoneMatchMatchmakingService.handleSearchStart(io, socket);
    });
  });
  socket.on('zone:search_cancel', (payload) => {
    const parsed = searchCancelSchema.safeParse(payload);
    if (!parsed.success) return;
    // Cancel rides the cheap sync bucket: it must never be starved by the start budget it does not consume.
    runLimited(socket, 'zone:search_cancel', 'sync', () => zoneMatchMatchmakingService.handleSearchCancel(io, socket, parsed.data.searchId));
  });
}
