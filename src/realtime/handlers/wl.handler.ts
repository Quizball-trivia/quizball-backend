/**
 * Weekend League room membership. Broadcasts go to wl:{tid} (players) and
 * wl:{tid}:spec (spectators); this handler is the only way into either.
 *
 * Authorization: joining as a player requires a live entry in the
 * tournament; anyone authenticated may join as a spectator of a non-deleted
 * tournament (the spectator stream is public, 30s-delayed content). A
 * socket may hold at most one WL room at a time — resubscribing moves it.
 */

import { z } from 'zod';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { wlPlayersRoom, wlSpectatorsRoom } from '../../modules/weekend-league/wl-deliverer.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';

const subscribeSchema = z.object({
  tournament_id: z.string().uuid(),
  role: z.enum(['player', 'spectator']),
}).strict();

type SubscribeAck = (response: {
  ok: boolean;
  reason?: 'not_entered' | 'not_found' | 'invalid';
  seq?: number;
}) => void;

async function leaveWlRooms(socket: QuizballSocket): Promise<void> {
  for (const room of socket.rooms) {
    if (room.startsWith('wl:')) await socket.leave(room);
  }
}

export function registerWlHandlers(_io: QuizballServer, socket: QuizballSocket): void {
  socket.on('wl:subscribe', async (raw: unknown, ack?: SubscribeAck) => {
    const parsed = subscribeSchema.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, reason: 'invalid' });
      return;
    }
    const userId = socket.data.user?.id;
    if (!userId) {
      ack?.({ ok: false, reason: 'invalid' });
      return;
    }
    const { tournament_id: tournamentId, role } = parsed.data;
    try {
      const [t] = await sql<{ id: string; live_delivered_seq: string }[]>`
        SELECT id, live_delivered_seq::text FROM wl_tournaments WHERE id = ${tournamentId}
      `;
      if (!t) {
        ack?.({ ok: false, reason: 'not_found' });
        return;
      }
      if (role === 'player') {
        const [entry] = await sql<{ user_id: string }[]>`
          SELECT user_id FROM wl_entries
          WHERE tournament_id = ${tournamentId} AND user_id = ${userId}
            AND state IN ('entered', 'playing', 'finalist', 'champion', 'eliminated')
        `;
        if (!entry) {
          ack?.({ ok: false, reason: 'not_entered' });
          return;
        }
      }
      await leaveWlRooms(socket);
      await socket.join(role === 'player' ? wlPlayersRoom(tournamentId) : wlSpectatorsRoom(tournamentId));
      // The ack carries the live cursor so the client knows which seq its
      // snapshot must reach before trusting the event stream.
      ack?.({ ok: true, seq: Number(t.live_delivered_seq) });
    } catch (error) {
      logger.warn({ err: error, tournamentId, userId }, 'wl:subscribe failed');
      ack?.({ ok: false, reason: 'invalid' });
    }
  });

  socket.on('wl:unsubscribe', async () => {
    await leaveWlRooms(socket).catch(() => {});
  });
}
