/** In-process hooks for the realtime layer. A block ends the player's running games at once (contract §5.5): the
 *  partner tables are updated in the block's transaction, and subscribers (ranked, game sockets) are told after it
 *  commits so they can disconnect the player and settle the match as a leave. */

import { logger } from '../../core/logger.js';

export interface PartnerPlayerBlockedEvent {
  slug: string;
  environment: 'test' | 'production';
  /** partner_players.id */
  playerId: string;
  externalPlayerId: string;
  /** users.id the game modules key on; null when the player never launched. */
  userId: string | null;
  /** Sessions the block revoked (issued and opened). */
  revokedSessionIds: string[];
  /** Started plays the block cancelled (no score event, the play stays used). */
  cancelledPlayIds: string[];
}

type Listener = (event: PartnerPlayerBlockedEvent) => void | Promise<void>;
const listeners = new Set<Listener>();

/** Subscribe to blocks; returns the unsubscribe function. */
export function onPartnerPlayerBlocked(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called once the block has committed. A failing subscriber is logged and never fails the block. */
export async function emitPartnerPlayerBlocked(event: PartnerPlayerBlockedEvent): Promise<void> {
  await Promise.all(
    [...listeners].map(async (listener) => {
      try {
        await listener(event);
      } catch (error) {
        logger.error({ err: error, playerId: event.playerId }, 'Partner block subscriber failed');
      }
    }),
  );
}
