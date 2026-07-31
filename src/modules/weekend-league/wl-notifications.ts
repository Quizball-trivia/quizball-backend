/**
 * WL notification waves — recipient-level idempotent AND crash-resumable:
 * the orchestrator re-runs each wave every pass until candidate exhaustion
 * (a pass that inserts nothing AND finds no remaining candidates), so a
 * crash mid-wave just continues next tick, and concurrent workers racing
 * batches terminate on truth rather than on inserted-row counts.
 *
 * Delivery is pull-based by design: rows land in the notifications table
 * and clients pick them up on their normal unread poll — no per-recipient
 * socket emission during a wave (a 600+ recipient burst through the
 * realtime path is exactly what the outbox design avoids).
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

const STARTED_CONTENT: WlWaveContent = {
  titleEn: 'Weekend League is starting!',
  titleKa: 'უიქენდის ლიგა იწყება!',
  bodyEn: 'Check in now if you are registered — or watch the games live.',
  bodyKa: 'გაიარე ჩექინი თუ დარეგისტრირებული ხარ — ან უყურე თამაშებს ლაივში.',
};

function sourceKey(tournamentId: string, kind: WlWaveKind): string {
  return `wl:${tournamentId}:${kind}`;
}

/** Insert the wave for every non-terminal entrant of the tournament. */
export async function wlNotifyEntrants(
  tournamentId: string,
  kind: WlWaveKind,
  content: WlWaveContent,
  stateFilter: string[] = ['entered', 'playing', 'finalist']
): Promise<number> {
  const key = sourceKey(tournamentId, kind);
  let total = 0;
  for (;;) {
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO notifications (user_id, type, title, body, data, source_event_key)
      SELECT e.user_id, 'weekend_league',
             ${sql.json({ en: content.titleEn, ka: content.titleKa } as never)},
             ${sql.json({ en: content.bodyEn, ka: content.bodyKa } as never)},
             ${sql.json({ tournament_id: tournamentId, kind } as never)},
             ${key}
      FROM wl_entries e
      WHERE e.tournament_id = ${tournamentId}
        AND e.state = ANY(${sql.array(stateFilter)})
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.user_id = e.user_id AND n.source_event_key = ${key}
        )
      LIMIT ${WAVE_BATCH_SIZE}
      ON CONFLICT (user_id, source_event_key) WHERE source_event_key IS NOT NULL
      DO NOTHING
      RETURNING id
    `;
    total += inserted.length;
    // Terminate on candidate exhaustion, not on inserted count: concurrent
    // workers make inserted < batch without meaning "done".
    if (inserted.length === 0) break;
  }
  if (total > 0) logger.info({ tournamentId, kind, total }, 'WL notification wave inserted');
  return total;
}

/**
 * Tournament-start announcement, reconciled by the orchestrator every pass
 * while check-in is open. Audience: entrants PLUS every human who played
 * ranked this accrual week (has a wl_qp row for the tournament's week) —
 * both index-backed reads, so no full users scan; "active player" here
 * means someone the event is actually relevant to. Entrants can check in,
 * the rest can spectate from the same tab.
 */
export async function wlEnsureStartedWave(tournamentId: string): Promise<number> {
  const key = sourceKey(tournamentId, 'started');
  const content = STARTED_CONTENT;
  let total = 0;
  for (;;) {
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO notifications (user_id, type, title, body, data, source_event_key)
      SELECT c.user_id, 'weekend_league',
             ${sql.json({ en: content.titleEn, ka: content.titleKa } as never)},
             ${sql.json({ en: content.bodyEn, ka: content.bodyKa } as never)},
             ${sql.json({ tournament_id: tournamentId, kind: 'started' } as never)},
             ${key}
      FROM (
        SELECT e.user_id FROM wl_entries e
        WHERE e.tournament_id = ${tournamentId}
          AND e.state IN ('entered', 'playing', 'finalist')
        UNION
        SELECT q.user_id FROM wl_qp q
        JOIN wl_tournaments t ON t.id = ${tournamentId} AND t.week_key = q.week_key
      ) c
      JOIN users u ON u.id = c.user_id
        AND u.is_ai = false AND u.is_seed = false AND u.is_deleted = false
        AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
        AND u.is_banned = false
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = c.user_id AND n.source_event_key = ${key}
      )
      LIMIT ${WAVE_BATCH_SIZE}
      ON CONFLICT (user_id, source_event_key) WHERE source_event_key IS NOT NULL
      DO NOTHING
      RETURNING id
    `;
    total += inserted.length;
    if (inserted.length === 0) break;
  }
  if (total > 0) logger.info({ tournamentId, total }, 'WL started wave inserted');
  return total;
}
