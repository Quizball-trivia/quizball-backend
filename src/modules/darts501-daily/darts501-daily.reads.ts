import { createDeadlineGuard } from '../../core/deadline-guard.js';
import { AppError, ErrorCode } from '../../core/errors.js';
import { withStatementTimeout, type sql, type TransactionSql } from '../../db/index.js';
import type { D501DayRow } from './darts501-daily.service.js';

/**
 * Every content read Football Darts 501 makes outside a player's own transaction, each with a real server-side bound
 * (SET LOCAL inside a transaction: the transaction pooler drops startup timeouts, so a plain statement has none).
 *
 * Why: these reads are shared. One content refresh is in flight per replica, and every boards, review, leaderboard,
 * start and suggestion call waits on it. A read that never answered (a lock wait or a lost connection) used to hold that
 * shared promise forever, so every Darts 501 request on that replica hung until it restarted. Production showed exactly
 * this after launch: GET /darts501/boards never answered while every other daily did, and the web client gave up with
 * "The game could not be loaded". Now a stuck read is cancelled by Postgres, abandoned by a deadline if the connection
 * itself is gone, and the next request asks again. An abandoned read still holds its database admission slot until it
 * settles, so while one is pending the same read is refused at once (a 503) instead of started again: at most one stuck
 * call per read, never a pile that would use up the process's admission budget.
 */
export const D501_READ_STATEMENT_MS = 8_000;
/** Longer than the statement bound, so Postgres' own cancel normally wins; this one covers a connection that never answers. */
export const D501_READ_DEADLINE_MS = 10_000;

export class D501ContentUnavailableError extends AppError {
  constructor(what: string) {
    super('Football Darts 501 is unavailable right now, please retry shortly', 503, ErrorCode.INTERNAL_ERROR, { reason: 'darts501_content_unavailable', what });
  }
}

/**
 * A wait on shared work, or a 503 once `ms` has passed. Only for waiting on work someone else started and owns (a cached
 * load): the wait is abandoned, the work is not, and nothing new is started. Work this call would start goes through
 * `bounded` instead.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new D501ContentUnavailableError(what)), ms);
    timer.unref?.();
  });
  // A late rejection of abandoned work must not surface as an unhandled rejection.
  work.catch(() => undefined);
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** postgres.js types a transaction without the tagged-template call it has (the same cast the daily kit's repo uses). */
const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;

const reads = createDeadlineGuard((what) => new D501ContentUnavailableError(what));

/** `what` names the read (and keys the guard): one read never blocks another. */
const bounded = <T>(what: string, run: (q: typeof sql) => Promise<T>): Promise<T> =>
  reads.run(what, D501_READ_DEADLINE_MS, () => withStatementTimeout((tx) => run(exec(tx)), D501_READ_STATEMENT_MS));

/** Tests and diagnostics: an abandoned read of this name is still pending. */
export const d501ReadStuck = (what: string): boolean => reads.stuck(what);

export const darts501Reads = {
  /** Changes whenever darts501_days changes (a seed or a correction). */
  async daysFingerprint(): Promise<string> {
    const [row] = await bounded('days fingerprint', (q) => q<Array<{ fingerprint: string }>>`
      SELECT concat_ws(':', count(*), extract(epoch FROM max(updated_at)), sum(content_version)) AS fingerprint FROM darts501_days`);
    return row?.fingerprint ?? '';
  },

  async loadDays(): Promise<D501DayRow[]> {
    const rows = await bounded('days', (q) => q<Array<{ day: string; number: number; contentVersion: string | number; category: unknown }>>`
      SELECT day::text AS day, number, content_version AS "contentVersion", category FROM darts501_days ORDER BY day`);
    return rows.map((row) => ({ ...row, contentVersion: Number(row.contentVersion) }));
  },

  /** Releases and coverage sets the enabled room categories and every live match use. */
  roomPairs(): Promise<Array<{ release: string; coverage: string }>> {
    return bounded('room pairs', (q) => q<Array<{ release: string; coverage: string }>>`
      SELECT DISTINCT payload->>'release' AS release, payload->>'coverage' AS coverage FROM room_pool WHERE game = 'darts501' AND enabled
      UNION
      SELECT DISTINCT l->>'release', l->>'coverage'
      FROM room_matches m JOIN room_match_content c ON c.match_id = m.id CROSS JOIN jsonb_array_elements(c.content->'legs') l
      WHERE m.game = 'darts501' AND m.status IN ('ready', 'active')`);
  },

  /** One page of a coverage set, in pid order after `after`. */
  coveragePage(id: string, after: string, limit: number): Promise<Array<{ pid: string }>> {
    return bounded(`coverage:${id}`, (q) => q<Array<{ pid: string }>>`
      SELECT pid FROM darts501_coverage WHERE coverage_id = ${id} AND pid > ${after} ORDER BY pid LIMIT ${limit}`);
  },
};
