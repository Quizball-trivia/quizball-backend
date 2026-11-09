import { createHmac } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';

type RoomContext = {
  id: string;
  invite_code?: string | null;
  mode?: string;
  status?: string;
  game_mode?: string | null;
  duel_game?: string | null;
  room_game?: string | null;
  is_public?: boolean;
  created_at?: string;
};

export type RoomLifecycleEvent = 'created' | 'state_observed' | 'member_joined' | 'member_left' | 'disconnect_reserved'
  | 'reservation_cleared' | 'reservation_expired' | 'deleted' | 'join_refused';

/** Stable across replicas/restarts; separate namespaces prevent joining this with other hashed signals.
 * No new credential is required: outside local, the SMS hook secret is already mandatory.
 * Never fall back to hashing an enumerable six-character invite without a secret.
 */
export function roomLifecycleKey(kind: 'invite' | 'member' | 'attempt', value?: string | null): string | null {
  if (!value) return null;
  const secret = config.GUEST_SIGNAL_HMAC_KEY ?? config.SUPABASE_SMS_HOOK_SECRET ?? config.SUPABASE_JWT_SECRET;
  if (!secret) return null;
  const normalized = kind === 'invite' ? value.trim().toUpperCase() : value;
  return createHmac('sha256', secret).update(`room-lifecycle:v1:${kind}:${normalized}`).digest('hex').slice(0, 32);
}

/** Info-level operational history, including after a room row has gone. Explicit fields only: no codes,
 * tokens, socket IDs, profiles, IPs or raw member IDs. Tracking must never fail a gameplay operation.
 */
export function recordRoomLifecycle(event: RoomLifecycleEvent, room: RoomContext, details: {
  reason?: string;
  userId?: string;
  graceMs?: number;
  expiresAt?: string;
  memberCount?: number;
  correlationId?: string;
  code?: string;
  roomState?: string;
} = {}): void {
  if (room.mode && room.mode !== 'friendly') return;
  try {
    const created = room.created_at ? Date.parse(room.created_at) : NaN;
    logger.info({
      event: 'room_lifecycle', version: 1, action: event,
      lobbyId: room.id || null, inviteKey: roomLifecycleKey('invite', room.invite_code),
      memberKey: roomLifecycleKey('member', details.userId),
      status: room.status ?? null, gameMode: room.game_mode ?? null,
      duelGame: room.duel_game ?? null, roomGame: room.room_game ?? null,
      isPublic: room.is_public ?? null, ageMs: Number.isFinite(created) ? Math.max(0, Date.now() - created) : null,
      reason: details.reason ?? null, graceMs: details.graceMs ?? null,
      expiresAt: details.expiresAt ?? null, memberCount: details.memberCount ?? null,
      attemptKey: roomLifecycleKey('attempt', details.correlationId), code: details.code ?? null, roomState: details.roomState ?? null,
    }, 'Room lifecycle');
  } catch { /* Observability is best effort; room operations remain authoritative. */ }
}
