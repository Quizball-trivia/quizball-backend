/**
 * WL notification waves — recipient-level idempotent, crash-resumable.
 * Each wave inserts one notifications row per recipient with a
 * source_event_key; the UNIQUE (user_id, source_event_key) index makes a
 * resumed wave skip everyone already covered. No per-user unread-count
 * reads during the wave (the socket push is best-effort; badge counts
 * refresh on the next client pull).
 */

import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';

const WAVE_BATCH_SIZE = 200;

export type WlWaveKind = 'cancelled' | 'checkin_open' | 'started' | 'qualified' | 'final_checkin_open';

export interface WlWaveContent {
  titleEn: string;
  titleKa: string;
  bodyEn: string;
  bodyKa: string;
}

/**
 * Tournament-start announcement to the WHOLE active player base (entered or
 * not — entrants see "join", everyone else "watch live"). Bounded to humans
 * active in the last 14 days so a wave never touches thousands of dormant
 * accounts. Same recipient-level idempotency as entrant waves.
 */
export async function wlNotifyAllActiveUsers(
  tournamentId: string,
  kind: WlWaveKind,
  content: WlWaveContent
): Promise<number> {
  const sourceKey = `wl:${tournamentId}:${kind}`;
  let total = 0;
  for (;;) {
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO notifications (user_id, type, title, body, data, source_event_key)
      SELECT u.id, 'weekend_league',
             ${sql.json({ en: content.titleEn, ka: content.titleKa } as never)},
             ${sql.json({ en: content.bodyEn, ka: content.bodyKa } as never)},
             ${sql.json({ tournament_id: tournamentId, kind } as never)},
             ${sourceKey}
      FROM users u
      WHERE u.is_ai = false AND u.is_seed = false AND u.is_deleted = false
        AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
        AND u.is_banned = false
        AND u.updated_at > NOW() - interval '14 days'
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.user_id = u.id AND n.source_event_key = ${sourceKey}
        )
      LIMIT ${WAVE_BATCH_SIZE}
      ON CONFLICT (user_id, source_event_key) WHERE source_event_key IS NOT NULL
      DO NOTHING
      RETURNING id
    `;
    total += inserted.length;
    if (inserted.length < WAVE_BATCH_SIZE) break;
  }
  logger.info({ tournamentId, kind, total }, 'WL all-users notification wave inserted');
  return total;
}

/** Insert the wave for every non-terminal entrant of the tournament. */
export async function wlNotifyEntrants(
  tournamentId: string,
  kind: WlWaveKind,
  content: WlWaveContent,
  stateFilter: string[] = ['entered', 'playing', 'finalist']
): Promise<number> {
  const sourceKey = `wl:${tournamentId}:${kind}`;
  let total = 0;
  for (;;) {
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO notifications (user_id, type, title, body, data, source_event_key)
      SELECT e.user_id, 'weekend_league',
             ${sql.json({ en: content.titleEn, ka: content.titleKa } as never)},
             ${sql.json({ en: content.bodyEn, ka: content.bodyKa } as never)},
             ${sql.json({ tournament_id: tournamentId, kind } as never)},
             ${sourceKey}
      FROM wl_entries e
      WHERE e.tournament_id = ${tournamentId}
        AND e.state = ANY(${sql.array(stateFilter)})
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.user_id = e.user_id AND n.source_event_key = ${sourceKey}
        )
      LIMIT ${WAVE_BATCH_SIZE}
      ON CONFLICT (user_id, source_event_key) WHERE source_event_key IS NOT NULL
      DO NOTHING
      RETURNING id
    `;
    total += inserted.length;
    if (inserted.length < WAVE_BATCH_SIZE) break;
  }
  logger.info({ tournamentId, kind, total }, 'WL notification wave inserted');
  return total;
}
