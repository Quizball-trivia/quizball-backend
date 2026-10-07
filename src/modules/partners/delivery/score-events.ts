import type postgres from 'postgres';
import { z } from 'zod';
import { logger } from '../../../core/logger.js';

import { PARTNER_GAME_IDS, type PartnerGameId } from '../partner-games.js';

export { PARTNER_GAME_IDS, type PartnerGameId };

export type PartnerEnvironment = 'test' | 'production';

/** Contract v1.1 §6: the body Freecroco receives, nothing more. occurredAt is UTC ISO 8601 with milliseconds. */
export interface ScoreEventBody {
  eventId: string;
  sessionId: string;
  playerId: string;
  gameId: PartnerGameId;
  occurredAt: string;
  score: number;
}

export interface EnqueueScoreEventInput {
  playId: string;
  partnerSlug: string;
  environment: PartnerEnvironment;
  /** Freecroco's playerId, as received in sessions/init. */
  playerId: string;
  sessionId: string;
  gameId: PartnerGameId;
  score: number;
  /** When the play finished. */
  occurredAt: Date | string;
}

export interface EnqueuedScoreEvent {
  eventId: string;
  /** False when the play already had its event (that one is kept, untouched). */
  created: boolean;
}

const inputSchema = z.object({
  playId: z.string().uuid(),
  partnerSlug: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  environment: z.enum(['test', 'production']),
  playerId: z.string().regex(/^[A-Za-z0-9._:@-]{1,64}$/),
  sessionId: z.string().uuid(),
  gameId: z.enum(PARTNER_GAME_IDS),
  score: z.number().int().min(0).max(2_147_483_647),
  occurredAt: z.union([z.date(), z.string().datetime({ offset: true })]),
});

export const scoreEventIdFor = (playId: string): string => `qb_${playId.toLowerCase()}`;

/** The wire body in the contract's field order (jsonb does not keep key order). */
export function scoreEventBody(payload: Record<string, unknown>): ScoreEventBody {
  return {
    eventId: payload.eventId as string,
    sessionId: payload.sessionId as string,
    playerId: payload.playerId as string,
    gameId: payload.gameId as PartnerGameId,
    occurredAt: payload.occurredAt as string,
    score: payload.score as number,
  };
}

/**
 * Queues the play's score event in the caller's transaction, so the event exists exactly when the finished play
 * does. One event per play, ever: a repeat returns the existing event and changes nothing.
 */
export async function enqueuePartnerScoreEvent(
  transaction: postgres.TransactionSql,
  input: EnqueueScoreEventInput,
): Promise<EnqueuedScoreEvent> {
  // Only a transaction handle has savepoint(): outside one, the event could commit without its play.
  if (typeof (transaction as Partial<postgres.TransactionSql>).savepoint !== 'function') {
    throw new Error('enqueuePartnerScoreEvent must run inside the transaction that finishes the play');
  }
  const tx = transaction as unknown as postgres.Sql;
  const v = inputSchema.parse(input);
  const playId = v.playId.toLowerCase();
  const eventId = scoreEventIdFor(playId);
  const occurredAt = new Date(v.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) throw new Error('occurredAt is not a valid time');
  const body: ScoreEventBody = {
    eventId,
    sessionId: v.sessionId.toLowerCase(),
    playerId: v.playerId,
    gameId: v.gameId,
    occurredAt: occurredAt.toISOString(),
    score: v.score,
  };

  const inserted = await tx`
    INSERT INTO partner_score_events
      (event_id, partner_slug, environment, play_id, player_id, session_id, game_id, score, occurred_at, payload)
    VALUES (${eventId}, ${v.partnerSlug}, ${v.environment}, ${playId}, ${v.playerId}, ${body.sessionId},
            ${v.gameId}, ${v.score}, ${occurredAt}, ${tx.json(body as unknown as postgres.JSONValue)})
    ON CONFLICT DO NOTHING
    RETURNING event_id`;
  if (inserted.length) return { eventId, created: true };

  const [existing] = await tx<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM partner_score_events WHERE play_id = ${playId}`;
  if (!existing) throw new Error(`partner score event ${eventId} conflicts with another event`);
  const kept = scoreEventBody(existing.payload);
  if (JSON.stringify(kept) !== JSON.stringify(body)) {
    // A second, different result for the same play is a bug upstream; the first one stays the reported one.
    logger.error({ eventId, kept, refused: body }, 'Partner score event repeated with a different result; kept the first');
  }
  return { eventId, created: false };
}
