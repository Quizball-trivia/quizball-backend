/** One start path for the Freecroco Road to Goal and Trivia Mines runs: every start of a player's game is serialized,
 *  so the same start id always returns the same run and never spends a second play, whatever races it. */

import type { TransactionSql } from '../../../../db/index.js';
import { partnerBegin, partnerSavepoint } from '../../partner-analytics.js';
import { asSql } from '../../partner-db.js';
import { PartnerError } from '../../partner-errors.js';
import type { PartnerGameId } from '../../partner-games.js';
import type { PartnerPrincipal } from '../../partner-player-auth.js';
import { reservePlay, type PartnerPlay } from '../../partner-quota.service.js';
import { afterPartnerSettle } from '../kit.js';

/**
 * First lock of every G4 transaction that may touch a play or the quota: the player row, shared. A block locks the same
 * row exclusively before it cancels plays, and finishPlay/reservePlay lock player before play, so taking it first
 * (before any run, play or quota lock) keeps one order everywhere and a block can never deadlock with a game.
 */
export async function lockPlayerFirst(tx: TransactionSql, playerId: string): Promise<void> {
  await asSql(tx)`SELECT 1 FROM partner_players WHERE id = ${playerId} FOR SHARE`;
}

export interface PartnerStartHooks {
  /** Locks the player's open run, settles it if it is already over, and returns its id if it goes on. */
  resumeOpen(tx: TransactionSql): Promise<{ runId: string | null; settled: boolean }>;
  /** Creates the run for a freshly reserved play. */
  create(tx: TransactionSql, play: PartnerPlay): Promise<string>;
}

export async function startPartnerRun(
  partner: PartnerPrincipal,
  gameId: PartnerGameId,
  startId: string,
  hooks: PartnerStartHooks,
): Promise<string> {
  const outcome = await partnerBegin(async (tx) => {
    const db = asSql(tx);
    await lockPlayerFirst(tx, partner.playerId);
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-start:${partner.playerId}:${gameId}`}, 0))`;
    const [known] = await db<{ run_id: string }[]>`
      SELECT run_id FROM partner_game_starts
      WHERE player_id = ${partner.playerId} AND game_id = ${gameId} AND start_id = ${startId}`;
    if (known) return { runId: known.run_id, settled: false, error: null };

    const open = await hooks.resumeOpen(tx);
    let runId = open.runId;
    let error: PartnerError | null = null;
    if (!runId) {
      try {
        // A refused reservation (no plays left) must not undo the settlement of the run that just ended above.
        runId = await partnerSavepoint(tx, async (sp) => {
          const play = await reservePlay(sp, {
            playerId: partner.playerId,
            sessionId: partner.sessionId,
            gameId,
            sourceRef: `${partner.playerId}:${startId}`,
          });
          if (play.state !== 'started') throw new PartnerError('play_not_active');
          return hooks.create(sp, play);
        });
      } catch (caught) {
        if (!(caught instanceof PartnerError)) throw caught;
        error = caught;
      }
    }
    if (runId) {
      await db`
        INSERT INTO partner_game_starts (player_id, game_id, start_id, run_id)
        VALUES (${partner.playerId}, ${gameId}, ${startId}, ${runId})`;
    }
    return { runId, settled: open.settled, error };
  }) as { runId: string | null; settled: boolean; error: PartnerError | null };
  if (outcome.settled) afterPartnerSettle();
  if (outcome.error || !outcome.runId) throw outcome.error ?? new PartnerError('internal_error');
  return outcome.runId;
}
