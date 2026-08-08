/**
 * Event-day forensics: durable, queryable traces of the two things Railway
 * logs cannot answer after the fact (replica-B logs are invisible via CLI —
 * see the Talakha forfeit postmortem):
 *
 *   1. wl_client_events — who connected/disconnected/subscribed when, with
 *      role and resume position. "Player X says they were kicked at Q7" is
 *      answerable from SQL instead of log archaeology.
 *   2. wl_answer_rejects — every REJECTED answer submission with its reason
 *      and raw payload. Accepted answers already persist in wl_answers;
 *      rejections used to vanish into a client ack.
 *
 * Writes are buffered and flushed in the background so the answer hot path
 * (Redis-only by design, see the hot-path caches) never gains a PG
 * round-trip. Loss on hard crash is acceptable — this is forensics, not
 * accounting.
 */
import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';

const FLUSH_INTERVAL_MS = 2_000;
const MAX_BUFFER = 5_000;

interface ClientEvent {
  tournament_id: string;
  user_id: string;
  kind: 'subscribe' | 'disconnect';
  meta: Record<string, unknown>;
}

interface AnswerReject {
  tournament_id: string;
  attempt_id: string | null;
  user_id: string;
  reason: string;
  answer: unknown;
}

const clientBuf: ClientEvent[] = [];
const rejectBuf: AnswerReject[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
  timer.unref();
}

export function wlLogClientEvent(ev: ClientEvent): void {
  if (clientBuf.length >= MAX_BUFFER) return;
  clientBuf.push(ev);
  ensureTimer();
}

export function wlLogAnswerReject(ev: AnswerReject): void {
  if (rejectBuf.length >= MAX_BUFFER) return;
  rejectBuf.push(ev);
  ensureTimer();
}

async function flush(): Promise<void> {
  if (clientBuf.length > 0) {
    const batch = clientBuf.splice(0, clientBuf.length);
    try {
      await sql`
        INSERT INTO wl_client_events (tournament_id, user_id, kind, meta)
        SELECT * FROM jsonb_to_recordset(${sql.json(batch as never)})
          AS t(tournament_id uuid, user_id uuid, kind text, meta jsonb)
      `;
    } catch (error) {
      logger.warn({ err: error, dropped: batch.length }, 'wl forensics: client-event flush failed');
    }
  }
  if (rejectBuf.length > 0) {
    const batch = rejectBuf.splice(0, rejectBuf.length);
    try {
      await sql`
        INSERT INTO wl_answer_rejects (tournament_id, attempt_id, user_id, reason, answer)
        SELECT * FROM jsonb_to_recordset(${sql.json(batch as never)})
          AS t(tournament_id uuid, attempt_id uuid, user_id uuid, reason text, answer jsonb)
      `;
    } catch (error) {
      logger.warn({ err: error, dropped: batch.length }, 'wl forensics: reject flush failed');
    }
  }
}

/** Test/shutdown hook. */
export async function wlForensicsFlushNow(): Promise<void> {
  await flush();
}
