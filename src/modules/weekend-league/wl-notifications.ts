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
// Bound per pass so one wave can never hold the orchestrator lock past its
// TTL — the remainder continues next pass (waves are state-reconciled).
const MAX_BATCHES_PER_PASS = 10;

export type WlWaveKind =
  | 'cancelled' | 'checkin_open' | 'started' | 'qualified' | 'final_checkin_open'
  | 'reminder_1h' | 'reminder_30m' | 'entry_open';

export interface WlWaveContent {
  titleEn: string;
  titleKa: string;
  bodyEn: string;
  bodyKa: string;
}

export const ENTRY_OPEN_CONTENT: WlWaveContent = {
  titleEn: 'You qualified for the Weekend League!',
  titleKa: 'უიქენდის ლიგაზე კვალიფიცირებული ხარ!',
  bodyEn: 'You have enough QP — entry is open. Claim your spot for Saturday now.',
  bodyKa: 'საკმარისი QP გაქვს — რეგისტრაცია ღიაა. დაიკავე ადგილი შაბათისთვის ახლავე.',
};

export const REMINDER_1H_CONTENT: WlWaveContent = {
  titleEn: 'Weekend League starts in 1 hour!',
  titleKa: 'უიქენდის ლიგა 1 საათში იწყება!',
  bodyEn: 'You are registered — check-in opens shortly before kickoff. Get ready! 🏆',
  bodyKa: 'დარეგისტრირებული ხარ — ჩექინი დაწყებამდე ცოტა ხნით ადრე გაიხსნება. მოემზადე! 🏆',
};

export const REMINDER_30M_CONTENT: WlWaveContent = {
  titleEn: 'Weekend League starts in 30 minutes!',
  titleKa: 'უიქენდის ლიგა 30 წუთში იწყება!',
  bodyEn: 'Almost time — do not miss check-in. Good luck! ⚽',
  bodyKa: 'თითქმის დროა — არ გამოტოვო ჩექინი. წარმატებები! ⚽',
};

export const CHECKIN_OPEN_CONTENT: WlWaveContent = {
  titleEn: 'Check-in is open!',
  titleKa: 'ჩექინი გახსნილია!',
  bodyEn: 'Confirm your spot — the games start soon.',
  bodyKa: 'დაადასტურე მონაწილეობა — თამაშები მალე იწყება.',
};

export const QUALIFIED_CONTENT: WlWaveContent = {
  titleEn: 'You made the final!',
  titleKa: 'ფინალში გახვედი!',
  bodyEn: 'Top 24 — the Sunday final awaits. Check in before it starts.',
  bodyKa: 'საუკეთესო 24-ში ხარ — ფინალი გელოდება. გაიარე ჩექინი დაწყებამდე.',
};

export const FINAL_CHECKIN_CONTENT: WlWaveContent = {
  titleEn: 'Final check-in is open!',
  titleKa: 'ფინალის ჩექინი გახსნილია!',
  bodyEn: 'Confirm your seat in the final now.',
  bodyKa: 'დაადასტურე შენი ადგილი ფინალში ახლავე.',
};

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
  for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO notifications (user_id, type, title, body, data, source_event_key)
      SELECT e.user_id, 'weekend_league',
             ${sql.json({ en: content.titleEn, ka: content.titleKa } as never)},
             ${sql.json({ en: content.bodyEn, ka: content.bodyKa } as never)},
             ${sql.json({ tournament_id: tournamentId, kind } as never)},
             ${key}
      FROM wl_entries e
      JOIN users u ON u.id = e.user_id
        AND u.is_ai = false AND u.is_seed = false AND u.is_deleted = false
        AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
        AND u.is_banned = false
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
  for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
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


/**
 * Email leg of a reminder wave: same audience contract as wlNotifyEntrants
 * (non-terminal entrants, human-only guards), idempotent per recipient via
 * wl_email_log. Sends are paced per pass (the orchestrator re-runs the wave
 * until candidate exhaustion). Every attempt is recorded: failures keep
 * sent_at NULL and count attempts, retried until a cap of 5 so dead
 * addresses leave the candidate window. When no email provider is
 * configured this is a no-op that records nothing.
 */
/** Owner-approved layout (2026-08-03): Georgian first, English in grey
 *  below, one green CTA into the events tab. */
export function wlEmailHtml(subject: WlWaveContent): string {
  return `
    <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; padding: 24px 16px;">
      <div style="font-size: 26px; margin-bottom: 8px;">🏆</div>
      <h2 style="margin: 0 0 6px; color: #111;">${subject.titleKa}</h2>
      <p style="margin: 0 0 20px; color: #444; line-height: 1.5;">${subject.bodyKa}</p>
      <h3 style="margin: 0 0 4px; color: #888; font-weight: 600;">${subject.titleEn}</h3>
      <p style="margin: 0 0 20px; color: #888; line-height: 1.5;">${subject.bodyEn}</p>
      <a href="https://quizball.io/events" style="display: inline-block; background: #38B60E; color: #fff; padding: 13px 26px; border-radius: 10px; text-decoration: none; font-weight: 700;">quizball.io/events</a>
    </div>`;
}

export async function wlEmailEntrants(
  tournamentId: string,
  kind: WlWaveKind,
  subject: WlWaveContent,
  stateFilter: string[] = ['entered', 'playing', 'finalist']
): Promise<number> {
  const { emailEnabled, sendEmail } = await import('../../core/email.js');
  if (!emailEnabled()) return 0;
  const key = sourceKey(tournamentId, kind);
  const EMAILS_PER_PASS = 40;
  // The orchestrator holds a TTL lock across this pass: the batch is
  // TIME-boxed (not just count-boxed) so slow provider responses can never
  // starve the lock — leftovers go out on the next pass.
  const passDeadline = Date.now() + 8_000;
  const candidates = await sql<Array<{ user_id: string; email: string | null; nickname: string | null }>>`
    SELECT e.user_id, u.email, u.nickname
    FROM wl_entries e
    JOIN users u ON u.id = e.user_id
      AND u.is_ai = false AND u.is_seed = false AND u.is_deleted = false
      AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
      AND u.is_banned = false
    WHERE e.tournament_id = ${tournamentId}
      AND e.state = ANY(${sql.array(stateFilter)})
      AND u.email IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM wl_email_log l
        WHERE l.user_id = e.user_id AND l.source_event_key = ${key}
          AND (l.sent_at IS NOT NULL OR l.attempts >= 5)
      )
    ORDER BY e.user_id
    LIMIT ${EMAILS_PER_PASS}
  `;
  let sent = 0;
  for (const c of candidates) {
    if (Date.now() > passDeadline) break;
    if (!c.email) continue;
    const ok = await sendEmail({
      to: c.email,
      idempotencyKey: `${key}:${c.user_id}`,
      subject: subject.titleEn,
      html: wlEmailHtml(subject),
    });
    // Success and failure BOTH leave durable state: failures count attempts
    // (retried until the cap, then excluded), so dead addresses can never
    // occupy the candidate window and starve later entrants.
    await sql`
      INSERT INTO wl_email_log (user_id, source_event_key, sent_at, attempts)
      VALUES (${c.user_id}, ${key}, ${ok ? new Date() : null}, 1)
      ON CONFLICT (user_id, source_event_key) DO UPDATE SET
        sent_at = COALESCE(wl_email_log.sent_at, EXCLUDED.sent_at),
        attempts = wl_email_log.attempts + 1,
        last_attempt_at = now()
    `;
    if (ok) sent += 1;
  }
  if (sent > 0) logger.info({ tournamentId, kind, sent }, 'WL reminder emails sent');
  return sent;
}


/**
 * Entry-opened announcement to QP-QUALIFIED players only (owner decision
 * 2026-08-03): users whose current accrual balance meets the tournament's
 * entry target and who have not already entered. In-app + email, both
 * recipient-idempotent through the same keys as every other wave.
 */
export async function wlNotifyQualifiedEntryOpen(
  tournamentId: string,
  qpTarget: number
): Promise<void> {
  const key = sourceKey(tournamentId, 'entry_open');
  const content = ENTRY_OPEN_CONTENT;
  for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO notifications (user_id, type, title, body, data, source_event_key)
      SELECT q.user_id, 'weekend_league',
             ${sql.json({ en: content.titleEn, ka: content.titleKa } as never)},
             ${sql.json({ en: content.bodyEn, ka: content.bodyKa } as never)},
             ${sql.json({ tournament_id: tournamentId, kind: 'entry_open' } as never)},
             ${key}
      FROM (
        SELECT a.user_id
        FROM wl_qp_awards a
        WHERE NOT EXISTS (
          SELECT 1 FROM wl_qp_resets r
          WHERE r.user_id = a.user_id AND r.reset_at > a.created_at
        )
        GROUP BY a.user_id
        HAVING SUM(a.points) >= ${qpTarget}
      ) q
      JOIN users u ON u.id = q.user_id
        AND u.is_ai = false AND u.is_seed = false AND u.is_deleted = false
        AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
        AND u.is_banned = false
      WHERE NOT EXISTS (
        SELECT 1 FROM wl_entries e
        WHERE e.tournament_id = ${tournamentId} AND e.user_id = q.user_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = q.user_id AND n.source_event_key = ${key}
      )
      LIMIT ${WAVE_BATCH_SIZE}
      ON CONFLICT (user_id, source_event_key) WHERE source_event_key IS NOT NULL
      DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) break;
  }

  // Email leg: same qualified audience, wl_email_log attempt semantics.
  const { emailEnabled, sendEmail } = await import('../../core/email.js');
  if (!emailEnabled()) return;
  const passDeadline = Date.now() + 8_000;
  const candidates = await sql<Array<{ user_id: string; email: string | null }>>`
    SELECT q.user_id, u.email
    FROM (
      SELECT a.user_id
      FROM wl_qp_awards a
      WHERE NOT EXISTS (
        SELECT 1 FROM wl_qp_resets r
        WHERE r.user_id = a.user_id AND r.reset_at > a.created_at
      )
      GROUP BY a.user_id
      HAVING SUM(a.points) >= ${qpTarget}
    ) q
    JOIN users u ON u.id = q.user_id
      AND u.is_ai = false AND u.is_seed = false AND u.is_deleted = false
      AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
      AND u.is_banned = false
    WHERE u.email IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM wl_entries e
        WHERE e.tournament_id = ${tournamentId} AND e.user_id = q.user_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM wl_email_log l
        WHERE l.user_id = q.user_id AND l.source_event_key = ${key}
          AND (l.sent_at IS NOT NULL OR l.attempts >= 5)
      )
    ORDER BY q.user_id
    LIMIT 40
  `;
  let sent = 0;
  for (const c of candidates) {
    if (Date.now() > passDeadline) break;
    if (!c.email) continue;
    const ok = await sendEmail({
      to: c.email,
      idempotencyKey: `${key}:${c.user_id}`,
      subject: content.titleEn,
      html: wlEmailHtml(content),
    });
    await sql`
      INSERT INTO wl_email_log (user_id, source_event_key, sent_at, attempts)
      VALUES (${c.user_id}, ${key}, ${ok ? new Date() : null}, 1)
      ON CONFLICT (user_id, source_event_key) DO UPDATE SET
        sent_at = COALESCE(wl_email_log.sent_at, EXCLUDED.sent_at),
        attempts = wl_email_log.attempts + 1,
        last_attempt_at = now()
    `;
    if (ok) sent += 1;
  }
  if (sent > 0) logger.info({ tournamentId, sent }, 'WL entry-open qualified emails sent');
}
