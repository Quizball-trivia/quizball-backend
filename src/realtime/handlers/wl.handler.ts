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

const answerSchema = z.object({
  tournament_id: z.string().uuid(),
  attempt_id: z.string().uuid(),
  answer: z.unknown(),
}).strict();

type SubscribeAck = (response: {
  ok: boolean;
  reason?: 'not_entered' | 'not_found' | 'invalid';
  seq?: number;
  snapshot?: import('../../modules/weekend-league/wl-live-engine.js').WlSubscribeSnapshot | null;
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
      // Cursor C0 BEFORE the join: every event ≤ C0 predates this socket and
      // is (for players) reflected in the snapshot built below.
      const [t] = await sql<{ id: string; live_delivered_seq: string; spec_delivered_seq: string }[]>`
        SELECT id, live_delivered_seq::text, spec_delivered_seq::text
        FROM wl_tournaments WHERE id = ${tournamentId}
      `;
      if (!t) {
        ack?.({ ok: false, reason: 'not_found' });
        return;
      }
      if (role === 'player') {
        // Eliminated / no-show / withdrawn / disqualified users belong in the
        // DELAYED spectator room — the live room would leak undelayed
        // dispatches past the 30s protection. (State-change eviction of
        // already-joined sockets lands with the real eliminations in PR4.)
        const [entry] = await sql<{ user_id: string }[]>`
          SELECT user_id FROM wl_entries
          WHERE tournament_id = ${tournamentId} AND user_id = ${userId}
            AND state IN ('entered', 'playing', 'finalist', 'champion')
        `;
        if (!entry) {
          ack?.({ ok: false, reason: 'not_entered' });
          return;
        }
      }
      await leaveWlRooms(socket);
      await socket.join(role === 'player' ? wlPlayersRoom(tournamentId) : wlSpectatorsRoom(tournamentId));
      // Player-only state so a late join / transient reconnect resumes
      // mid-question instead of waiting out the current attempt. Spectators
      // get NO snapshot: their whole world is the 30s-delayed stream, and
      // live standings/status through the ack would leak ahead of it.
      let snapshot = null;
      if (role === 'player') {
        const { wlSubscribeSnapshot } = await import('../../modules/weekend-league/wl-live-engine.js');
        snapshot = await wlSubscribeSnapshot(tournamentId, userId).catch((error) => {
          logger.warn({ err: error, tournamentId, userId }, 'wl:subscribe snapshot failed');
          return null;
        });
      }
      // Close the join-window gap: events marked delivered between C0 (read
      // before the join) and C1 (read now) may have been BROADCAST before
      // this socket was in the room — replay them directly from the outbox
      // (their payloads are final, dispatch stamps included). The client
      // dedups by seq, so a double delivery is harmless; events > C1 either
      // arrive through the room or are caught by the next subscribe.
      const [c1] = await sql<{ live_delivered_seq: string; spec_delivered_seq: string }[]>`
        SELECT live_delivered_seq::text, spec_delivered_seq::text
        FROM wl_tournaments WHERE id = ${tournamentId}
      `;
      const lo = Number(role === 'player' ? t.live_delivered_seq : t.spec_delivered_seq);
      const hi = Number(
        role === 'player' ? c1?.live_delivered_seq ?? '0' : c1?.spec_delivered_seq ?? '0'
      );
      if (hi > lo) {
        const missed = await sql<Array<{ seq: string; type: string; payload: Record<string, unknown> }>>`
          SELECT seq::text, type, payload FROM wl_events
          WHERE tournament_id = ${tournamentId} AND seq > ${lo} AND seq <= ${hi}
          ORDER BY seq ASC
        `;
        if (missed.length > 0) {
          const { wlRedisNowMs } = await import('../../modules/weekend-league/wl-redis.js');
          const nowMs = await wlRedisNowMs();
          const rawEmit = socket as unknown as { emit: (event: string, payload: unknown) => void };
          for (const row of missed) {
            rawEmit.emit(`wl:${row.type}`, {
              ...row.payload,
              type: row.type,
              tournamentId,
              seq: Number(row.seq),
              serverNowAtEmit: nowMs,
              ...(role === 'spectator' ? { spectator: true } : {}),
            });
          }
        }
      }
      // Role-appropriate cursor: the seq this room's stream has reached
      // BEFORE the join (C0) — everything above it reaches the client via
      // the replay or the room, so nothing is silently skipped.
      ack?.({
        ok: true,
        seq: lo,
        snapshot,
      });
    } catch (error) {
      logger.warn({ err: error, tournamentId, userId }, 'wl:subscribe failed');
      ack?.({ ok: false, reason: 'invalid' });
    }
  });

  socket.on('wl:unsubscribe', async () => {
    await leaveWlRooms(socket).catch(() => {});
  });

  socket.on('wl:answer', async (raw: unknown, ack?: Parameters<
    import('../socket.types.js').ClientToServerEvents['wl:answer']
  >[1]) => {
    const parsed = answerSchema.safeParse(raw);
    if (!parsed.success) {
      ack?.({ accepted: false, reason: 'invalid' });
      return;
    }
    const userId = socket.data.user?.id;
    if (!userId) {
      ack?.({ accepted: false, reason: 'invalid' });
      return;
    }
    // Byte cap BEFORE any Redis/DB work — typed guesses are short strings.
    if (JSON.stringify(parsed.data.answer ?? null).length > 512) {
      ack?.({ accepted: false, reason: 'invalid' });
      return;
    }
    try {
      const { wlAcceptAnswer } = await import('../../modules/weekend-league/wl-live-engine.js');
      const result = await wlAcceptAnswer({
        tournamentId: parsed.data.tournament_id,
        attemptId: parsed.data.attempt_id,
        userId,
        answer: parsed.data.answer ?? null,
      });
      ack?.(result);
    } catch (error) {
      logger.warn({ err: error, userId }, 'wl:answer failed');
      ack?.({ accepted: false, reason: 'invalid' });
    }
  });
}
