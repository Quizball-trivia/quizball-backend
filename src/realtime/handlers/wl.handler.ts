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
  last_seq: z.number().int().nonnegative().optional(),
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
  head?: number;
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
    const { tournament_id: tournamentId, role, last_seq: lastSeq } = parsed.data;
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
      // Close the join-window gap. The boundary is a marker persisted BEFORE
      // the broadcast (the deliverer runs markLiveEmission, then emits, then
      // markDelivered): any event this socket could have missed by joining
      // mid-broadcast already has live_emitted_redis_ms set, so replaying
      // every emitted row above C0 covers the race regardless of when the
      // delivered cursor advances. Payloads are final in the outbox
      // (dispatch stamps persisted at emission); the client dedups by seq,
      // so double delivery through the room is harmless. Aborted/skipped
      // rows were never public and stay that way. Spectator replay is
      // additionally gated by the persisted visibility time, so the 30s
      // delay holds no matter what the cursors say.
      const { wlRedisNowMs } = await import('../../modules/weekend-league/wl-redis.js');
      const nowMs = await wlRedisNowMs();
      const cursor = Number(role === 'player' ? t.live_delivered_seq : t.spec_delivered_seq);
      // A reconnecting client tells us the last seq it actually received;
      // lowering the floor to it backfills everything the room broadcast
      // while the socket was down (the global cursors keep advancing and
      // know nothing about individual sockets). Same visibility gates as
      // the fresh-join replay, so nothing leaks early. The floor is a
      // reconnect aid, not a paging API: the resume window is capped at
      // 200 events behind the cursor and the lowered floor is granted at
      // most once per 5s per (user, tournament, role) via a Redis NX key —
      // socket-local state would reset on every reconnect and parallel
      // sockets would each get a fresh allowance. Redis down = no lowered
      // floor (fail closed); the fresh-join replay path is unaffected.
      let lo = cursor;
      if (typeof lastSeq === 'number' && lastSeq < cursor) {
        let granted = false;
        try {
          const { wlRedis } = await import('../../modules/weekend-league/wl-redis.js');
          granted = (await wlRedis().set(
            `wl:backfill:${tournamentId}:${userId}:${role}`,
            '1',
            { NX: true, PX: 5_000 }
          )) === 'OK';
        } catch {
          granted = false;
        }
        if (granted) lo = Math.max(lastSeq, cursor - 200);
      }
      let missed: Array<{ seq: string; type: string; payload: Record<string, unknown> }>;
      if (role === 'player') {
        missed = await sql<Array<{ seq: string; type: string; payload: Record<string, unknown> }>>`
          SELECT seq::text, type, payload FROM wl_events
          WHERE tournament_id = ${tournamentId} AND seq > ${lo}
            AND live_emitted_redis_ms IS NOT NULL
            AND aborted_at IS NULL AND skipped_at IS NULL
          ORDER BY seq ASC
          LIMIT 500
        `;
      } else {
        // Contiguous visible prefix only (same rule as wlDeliverSpectator):
        // an extended-visibility dispatch holds back everything behind it,
        // so a reveal can never be replayed before its question.
        const rows = await sql<Array<{ seq: string; type: string; payload: Record<string, unknown>; visible_at_spec_ms: string | null }>>`
          SELECT seq::text, type, payload, visible_at_spec_ms::text FROM wl_events
          WHERE tournament_id = ${tournamentId} AND seq > ${lo}
            AND delivered_at IS NOT NULL
            AND aborted_at IS NULL AND skipped_at IS NULL
          ORDER BY seq ASC
          LIMIT 500
        `;
        missed = [];
        for (const r of rows) {
          const visibleAt = r.visible_at_spec_ms == null ? null : Number(r.visible_at_spec_ms);
          if (visibleAt == null || visibleAt > nowMs) break;
          missed.push({ seq: r.seq, type: r.type, payload: r.payload });
        }
      }
      if (missed.length > 0) {
        const rawEmit = socket as unknown as { emit: (event: string, payload: unknown) => void };
        for (const row of missed) {
          // Spectators never get the answer key (see wlDeliverSpectator).
          const payload = role === 'spectator' && row.type === 'dispatch'
            ? { ...row.payload, evaluation: {} }
            : row.payload;
          rawEmit.emit(`wl:${row.type}`, {
            ...payload,
            type: row.type,
            tournamentId,
            seq: Number(row.seq),
            serverNowAtEmit: nowMs,
            ...(role === 'spectator' ? { spectator: true } : {}),
          });
        }
      }
      // Role-appropriate cursor: the seq this room's stream has reached
      // BEFORE the join (C0) — everything above it reaches the client via
      // the replay or the room, so nothing is silently skipped.
      ack?.({
        ok: true,
        seq: lo,
        // The snapshot's exact outbox boundary for its persisted component
        // (events ≤ head are fully reflected in it, events above it not at
        // all). Only meaningful WITH a snapshot — a failed or spectator
        // subscribe carries no score state a boundary could describe.
        ...(snapshot ? { head: snapshot.snapshot_seq } : {}),
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
