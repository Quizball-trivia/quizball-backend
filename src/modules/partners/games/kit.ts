/** Shared plumbing for every Freecroco game (docs/FREECROCO-GAME-STREAMS.md): a start reserves the day's play in the
 *  same transaction that creates the game state, and a finish settles the play and queues its score event in the
 *  same transaction that stores the result. Nothing here grants Quizball coins, XP, streaks or leaderboard entries. */

import type { Request } from 'express';
import type { TransactionSql } from '../../../db/index.js';
import { asSql } from '../partner-db.js';
import { partnerBegin, type PartnerPlayDetails } from '../partner-analytics.js';
import { PartnerError } from '../partner-errors.js';
import type { PartnerGameId } from '../partner-games.js';
import type { PartnerPrincipal } from '../partner-player-auth.js';
import { finishPlay, reservePlay, type PartnerPlay } from '../partner-quota.service.js';
import { enqueuePartnerScoreEvent, wakePartnerDelivery } from '../delivery/index.js';

export function partnerPlayer(req: Request): PartnerPrincipal {
  if (!req.partner) throw new PartnerError('session_ended');
  return req.partner;
}

/**
 * Reserves a play of `gameId` for today and runs `create` in the same transaction. `sourceRef` makes a retried start
 * return the same play (pass the client's start id, or the game row id the start creates).
 */
export async function startPartnerPlay<T>(
  partner: PartnerPrincipal,
  gameId: PartnerGameId,
  sourceRef: string,
  create: (tx: TransactionSql, play: PartnerPlay) => Promise<T>,
): Promise<{ play: PartnerPlay; result: T }> {
  return partnerBegin(async (tx) => {
    const play = await reservePlay(tx, { playerId: partner.playerId, sessionId: partner.sessionId, gameId, sourceRef });
    const result = await create(tx, play);
    return { play, result };
  });
}

/**
 * Finishes a play inside the caller's result transaction and queues its score event there too, so the event exists
 * exactly when the result does. `at` is when the play logically ended (a deadline settled late). A play cancelled by
 * a block comes back with state 'cancelled' and gets no event. `maxScore` replaces the game's fixed cap (see
 * finishPlay); `details` only label the play in analytics. Run the transaction with partnerBegin and call
 * `afterPartnerSettle()` once it commits.
 */
export async function settlePartnerPlay(
  tx: TransactionSql,
  playId: string,
  score: number,
  at?: Date,
  maxScore?: number,
  details?: PartnerPlayDetails,
): Promise<PartnerPlay> {
  const play = await finishPlay(tx, playId, score, { at, maxScore, details });
  if (play.state !== 'finished') return play;
  const [player] = await asSql(tx)<{ external_player_id: string }[]>`
    SELECT external_player_id FROM partner_players WHERE id = ${play.playerId}`;
  await enqueuePartnerScoreEvent(tx, {
    playId: play.id,
    partnerSlug: play.partnerSlug,
    environment: play.environment as 'test' | 'production',
    playerId: player.external_player_id,
    sessionId: play.sessionId,
    gameId: play.gameId,
    score: play.score ?? 0,
    occurredAt: play.finishedAt ?? new Date(),
  });
  return play;
}

/** Wakes the score sender so a committed event goes out now instead of at the next poll. */
export function afterPartnerSettle(): void {
  wakePartnerDelivery();
}
