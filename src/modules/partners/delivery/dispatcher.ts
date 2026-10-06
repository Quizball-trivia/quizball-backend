/**
 * Score-event delivery to the partner (contract v1.1 §6), ported from Table Derby's partner webhooks.
 *
 * Every replica runs a dispatcher. Due rows are claimed with a lease under FOR UPDATE SKIP LOCKED, so no two
 * replicas hold the same row, and a claimed row is not due again until its lease runs out. Claims are serialized
 * by a transaction-scoped advisory lock so the contract's "at most 10 requests in parallel from us" holds across
 * replicas (live leases are the sends in flight), not only per replica. An outcome is applied only while the lease is
 * still this claim's; a sender that dies mid-send leaves the row to the next claim after its lease, which records
 * that attempt as `lease_expired` and sends again: at least once, and the partner deduplicates by eventId.
 *
 * Network errors, timeouts, 408, 429 and 5xx are retried with exponential backoff and jitter (never sooner than
 * Retry-After) for 24 hours from enqueue or the last manual resend. The deadline is strict: no send starts at or
 * after it (checked at claim and again right before the request; an attempt already under way may still record its
 * outcome). A retry that would not fit before it, a Retry-After past it included, makes the event dead instead. Any other 4xx is dead at once; a 409 is Freecroco saying it already holds this eventId with a
 * different body, which we never send, so it gets its own alert. Dead events are logged at error level (the
 * alerting path).
 */

import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type postgres from 'postgres';
import type { Logger } from 'pino';
import { scoreEventBody, type PartnerEnvironment } from './score-events.js';

export const DELIVERY_TIMEOUT_MS = 10_000;
/** Well over a send and its recording: a live sender never outlasts its lease. */
export const DELIVERY_LEASE_MS = 60_000;
/** A send starts only with this much of its lease left beyond its timeout. */
const LEASE_MARGIN_MS = 5_000;
const POLL_MS = 5_000;
/** Contract v1.1 §6: at most 10 requests in parallel from us (per replica and across replicas). */
export const DELIVERY_CONCURRENCY = 10;
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Backoff retries are planned no later than this before the deadline, so the last one is claimed and started in
 *  time (a poll can be up to POLL_MS late). */
export const LAST_TRY_MARGIN_MS = 60_000;
export const BACKOFF_BASE_MS = 10_000;
export const BACKOFF_CAP_MS = 30 * 60 * 1000;
const FAILURE_LOG_MS = 60_000;
/** Transaction-scoped advisory lock serializing claims across replicas (the global in-flight cap needs it). */
const CLAIM_LOCK_KEY = 7_210_514_001;

export const ATTEMPT_ERRORS = ['timeout', 'dns', 'refused', 'reset', 'tls', 'network', 'aborted'] as const;
export type AttemptError = (typeof ATTEMPT_ERRORS)[number];

export interface DeliveryDestination {
  slug: string;
  environment: PartnerEnvironment;
  url: string;
  apiKey: string;
}

type Sql = postgres.Sql;

/** Short, bounded transactions (SET LOCAL only: these run behind the transaction pooler). The handle is typed as
 *  Sql because postgres.js's TransactionSql type drops the tagged-template call signature. */
export function deliveryTransaction<T>(sql: Sql, work: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (t) => {
    const tx = t as unknown as Sql;
    await tx.unsafe(
      'SET LOCAL lock_timeout = 1000; SET LOCAL statement_timeout = 5000; '
        + 'SET LOCAL idle_in_transaction_session_timeout = 10000',
    );
    return work(tx);
  }) as Promise<T>;
}

/** The destination id an event is bound to: the URL's origin and a hash of the whole URL (never the URL itself). */
export function destinationId(url: string): string {
  const u = new URL(url);
  return `${u.origin}#${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
}

/** Exponential from `baseMs`, capped, with equal jitter. */
export function retryDelayMs(
  attempt: number,
  random: () => number = Math.random,
  baseMs = BACKOFF_BASE_MS,
  capMs = BACKOFF_CAP_MS,
): number {
  const full = Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 30));
  return Math.round(full / 2 + random() * (full / 2));
}

/** A delay in seconds, or an absolute HTTP date kept as such: it is compared with the database clock, never turned
 *  into a delay by this replica's clock. */
export type RetryAfter = { delayMs: number } | { at: number };

/** `Retry-After` as seconds or an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(value: string | null): RetryAfter | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{1,9}$/.test(trimmed)) return { delayMs: Number(trimmed) * 1000 };
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? { at } : null;
}

/** Contract v1.1 §6: network errors, timeouts, 408, 429 and 5xx are retried; any other 4xx is final. */
export function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const NETWORK_CODES: [AttemptError, RegExp][] = [
  ['timeout', /^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/],
  ['dns', /^(ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME|ENODATA)$/],
  ['refused', /^(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)$/],
  ['reset', /^(ECONNRESET|EPIPE|ECONNABORTED|UND_ERR_SOCKET|UND_ERR_CLOSED)$/],
  ['tls', /^(ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH)/],
];

class SendTimeout extends Error {
  constructor() {
    super('score event send timed out');
    this.name = 'TimeoutError';
  }
}

/** Why a send got no answer: our stop, our timeout, else undici's cause codes. */
export function classifyError(error: unknown, stopped?: unknown): AttemptError {
  if (stopped !== undefined && error === stopped) return 'aborted';
  if (error instanceof SendTimeout || (error as { name?: string } | null)?.name === 'TimeoutError') return 'timeout';
  const codes: string[] = [];
  const collect = (e: unknown, depth: number) => {
    if (!e || typeof e !== 'object' || depth > 3) return;
    const { code, cause, errors } = e as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof code === 'string') codes.push(code);
    collect(cause, depth + 1);
    if (Array.isArray(errors)) for (const inner of errors) collect(inner, depth + 1);
  };
  collect(error, 0);
  for (const [kind, pattern] of NETWORK_CODES) if (codes.some((c) => pattern.test(c))) return kind;
  return 'network';
}

/** What an attempt is recorded as: nothing from the answer's body or the URL, only our own reading of it. Null for
 *  a 2xx. A 409 is Freecroco saying it holds this eventId with a different body. */
export function attemptClassification(o: { kind: 'answered'; status: number } | { kind: 'failed'; error: AttemptError }): string | null {
  if (o.kind === 'failed') return o.error;
  if (o.status >= 200 && o.status < 300) return null;
  return o.status === 409 ? 'dead_conflict' : `http_${o.status}`;
}

/**
 * How an attempt's outcome settles the event, by the database clock. A failure is retried after its backoff, planned
 * no later than `marginMs` before the deadline and never sooner than Retry-After; when that time does not fall
 * strictly between now and the deadline, there is no retry left and the event is dead.
 */
export function settleDecision(i: {
  delivered: boolean; permanent: boolean; aborted: boolean; now: number; windowEnd: number;
  delayMs: number; retryAfter: RetryAfter | null; marginMs: number;
}): { status: 'sent' | 'pending' | 'dead'; next: Date | null } {
  if (i.delivered) return { status: 'sent', next: null };
  if (i.permanent || i.now >= i.windowEnd) return { status: 'dead', next: null };
  if (i.aborted) return { status: 'pending', next: new Date(i.now) };
  const planned = Math.min(i.now + i.delayMs, i.windowEnd - i.marginMs);
  const floor = !i.retryAfter ? i.now : 'at' in i.retryAfter ? i.retryAfter.at : i.now + i.retryAfter.delayMs;
  const next = Math.max(planned, floor);
  if (next >= i.windowEnd || next <= i.now) return { status: 'dead', next: null };
  return { status: 'pending', next: new Date(next) };
}

interface Claimed {
  id: string;
  event_id: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'dead';
  attempts: number;
  last_error: string | null;
  /** Bound to the destination by this claim (it had none). */
  unbound: boolean;
  /** Time left before the deadline when claimed, by the database clock. */
  remaining_ms: number;
}

type Outcome =
  | { kind: 'answered'; status: number; latencyMs: number; retryAfter: RetryAfter | null }
  | { kind: 'failed'; error: AttemptError; latencyMs: number };

type DeliveryLog = Pick<Logger, 'info' | 'warn' | 'error'>;

export interface ScoreEventDispatcherDeps {
  sql: Sql;
  /** Read on every round: null (partner or webhook not configured) keeps the dispatcher idle. */
  destination: () => DeliveryDestination | null;
  log: DeliveryLog;
  /** Tests change these. */
  fetch?: typeof fetch;
  pollMs?: number;
  timeoutMs?: number;
  leaseMs?: number;
  leaseMarginMs?: number;
  concurrency?: number;
  /** Sends in flight across every replica. */
  globalConcurrency?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  windowMs?: number;
  lastTryMarginMs?: number;
  random?: () => number;
  /** Monotonic milliseconds for the send guards (tests control it). */
  now?: () => number;
  /** Test hook: runs after the claim, right before the deadline check and the request. */
  beforeSend?: (eventId: string) => Promise<void>;
  /** An event reached a final state (sent, or dead), after that state committed. Must not throw. */
  onFinal?: (outcome: { eventId: string; status: 'sent' | 'dead'; attempts: number; lastError: string | null }) => void;
}

export class ScoreEventDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly inflight = new Map<string, Promise<void>>();
  private pumping: Promise<void> | null = null;
  private again = false;
  private claiming = true;
  private failingSince = 0;
  private failureLoggedAt = 0;
  private readonly stopping = new AbortController();
  private readonly stopReason = new Error('replica stopping');

  constructor(private readonly deps: ScoreEventDispatcherDeps) {}

  private clock(): number {
    return this.deps.now ? this.deps.now() : performance.now();
  }

  /** Sends in flight on this replica. */
  get sending(): number {
    return this.inflight.size;
  }

  private get leaseMs() {
    return this.deps.leaseMs ?? DELIVERY_LEASE_MS;
  }

  private get timeoutMs() {
    return this.deps.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  }

  start(): void {
    if (this.timer || !this.claiming) return;
    this.timer = setInterval(() => this.wake(), this.deps.pollMs ?? POLL_MS);
    this.timer.unref();
    this.wake();
  }

  /** Look for due events now (after a commit that queued or resent some). */
  wake(): void {
    if (!this.claiming) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
    });
  }

  /** Resolves when no claim is under way and nothing is in flight (tests). */
  async idle(): Promise<void> {
    while (this.pumping || this.inflight.size) {
      await Promise.allSettled([...(this.pumping ? [this.pumping] : []), ...this.inflight.values()]);
    }
  }

  /** Stop: no new claims; sends in flight are aborted and recorded (due again at once, for another replica).
   *  Waits at most `ms`. */
  async close(ms: number): Promise<void> {
    this.claiming = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopping.abort(this.stopReason);
    const work = [...(this.pumping ? [this.pumping] : []), ...this.inflight.values()];
    if (!work.length) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(work),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }

  private async pump(): Promise<void> {
    try {
      do {
        this.again = false;
        const dest = this.deps.destination();
        if (!dest) return;
        while (this.claiming) {
          const free = (this.deps.concurrency ?? DELIVERY_CONCURRENCY) - this.inflight.size;
          if (free <= 0) break;
          if (!(await this.anyDue(dest))) break;
          const lease = randomUUID();
          const issued = this.clock();
          const rows = await this.claim(dest, lease, free);
          if (!rows) break;
          const live = rows.filter((r) => r.status === 'pending');
          for (const row of rows) if (row.status === 'dead') this.deadLettered(dest, row, row.attempts, row.last_error);
          if (!this.claiming) {
            await this.release(live, lease);
            break;
          }
          for (const row of live) this.launch(dest, row, lease, issued);
          if (rows.length < free) break;
        }
      } while (this.again && this.claiming);
      this.failingSince = 0;
    } catch (error) {
      const now = Date.now();
      if (!this.failingSince) this.failingSince = now;
      if (now - this.failureLoggedAt >= FAILURE_LOG_MS) {
        this.failureLoggedAt = now;
        this.deps.log.warn({ err: error, failingForMs: now - this.failingSince }, 'Partner score event claim failed');
      }
    }
  }

  /** Keyed by claim as well as row: an outcome still being recorded after its lease ran out keeps its slot. */
  private launch(dest: DeliveryDestination, row: Claimed, lease: string, issued: number): void {
    const key = `${row.id}:${lease}`;
    const run = this.deliver(dest, row, lease, issued)
      .catch((error: unknown) => {
        this.deps.log.warn({ err: error, eventId: row.event_id }, 'Partner score event attempt not recorded');
      })
      .finally(() => {
        this.inflight.delete(key);
        this.wake();
      });
    this.inflight.set(key, run);
  }

  /** Cheap, lock-free check so an idle replica's poll is one index probe, not a transaction. */
  private async anyDue(dest: DeliveryDestination): Promise<boolean> {
    const [row] = await this.deps.sql<{ due: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM partner_score_events
        WHERE status = 'pending' AND partner_slug = ${dest.slug} AND environment = ${dest.environment}
          AND next_attempt_at <= now() AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      ) AS due`;
    return Boolean(row?.due);
  }

  /** Due rows of this destination under `lease`, bound to it if they were not yet. In the same statement, a row
   *  whose last lease ran out unacknowledged gets that attempt recorded as `lease_expired`, and a row past its
   *  window and the grace is given up instead (returned `dead`). Null: another replica is claiming right now. */
  private claim(dest: DeliveryDestination, lease: string, limit: number): Promise<Claimed[] | null> {
    const leaseS = this.leaseMs / 1000;
    const windowS = (this.deps.windowMs ?? RETRY_WINDOW_MS) / 1000;
    const bound = destinationId(dest.url);
    const globalCap = this.deps.globalConcurrency ?? DELIVERY_CONCURRENCY;
    return deliveryTransaction(this.deps.sql, async (tx) => {
      const [lock] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(${CLAIM_LOCK_KEY}) AS ok`;
      if (!lock?.ok) return null;
      const [flying] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM partner_score_events
        WHERE status = 'pending' AND lease_token IS NOT NULL AND lease_expires_at > now()
          AND partner_slug = ${dest.slug} AND environment = ${dest.environment}`;
      const room = Math.min(limit, globalCap - (flying?.n ?? 0));
      if (room <= 0) return [];
      return tx<Claimed[]>`
        WITH due AS (
          SELECT id, lease_token AS old_lease, lease_expires_at AS old_expiry, destination IS NULL AS unbound,
            now() >= coalesce(revived_at, created_at) + make_interval(secs => ${windowS}) AS expired,
            coalesce(revived_at, created_at) + make_interval(secs => ${windowS}) AS window_end
          FROM partner_score_events
          WHERE status = 'pending' AND next_attempt_at <= now()
            AND (lease_expires_at IS NULL OR lease_expires_at <= now())
            AND partner_slug = ${dest.slug} AND environment = ${dest.environment}
            AND (destination IS NULL OR destination = ${bound}
                 OR now() >= coalesce(revived_at, created_at) + make_interval(secs => ${windowS}))
          ORDER BY next_attempt_at, id
          LIMIT ${room}
          FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE partner_score_events o SET
            status = CASE WHEN due.expired THEN 'dead' ELSE 'pending' END,
            dead_at = CASE WHEN due.expired THEN now() ELSE o.dead_at END,
            last_error = CASE WHEN NOT due.expired THEN o.last_error
                              WHEN due.old_lease IS NOT NULL THEN 'lease_expired'
                              ELSE coalesce(o.last_error, 'window_passed') END,
            attempts = CASE WHEN due.expired THEN o.attempts ELSE o.attempts + 1 END,
            lease_token = CASE WHEN due.expired THEN NULL ELSE ${lease}::uuid END,
            lease_expires_at = CASE WHEN due.expired THEN NULL ELSE now() + make_interval(secs => ${leaseS}) END,
            next_attempt_at = CASE WHEN due.expired THEN o.next_attempt_at
                                   ELSE now() + make_interval(secs => ${leaseS}) END,
            destination = CASE WHEN due.expired THEN o.destination ELSE coalesce(o.destination, ${bound}) END
          FROM due
          WHERE o.id = due.id
          RETURNING o.id, o.event_id, o.payload, o.status, o.attempts, o.last_error,
            due.old_lease, due.old_expiry, due.unbound, due.window_end
        ), expired_leases AS (
          INSERT INTO partner_score_event_attempts (event_row_id, attempt, started_at, error)
          SELECT id, attempt, old_expiry - make_interval(secs => ${leaseS}), 'lease_expired'
          FROM (SELECT id, old_expiry, CASE WHEN status = 'dead' THEN attempts ELSE attempts - 1 END AS attempt
                FROM claimed WHERE old_lease IS NOT NULL) previous
          WHERE attempt >= 1
        )
        SELECT c.id::text AS id, c.event_id, c.payload, c.status, c.attempts, c.last_error, c.unbound,
          floor(extract(epoch FROM c.window_end - now()) * 1000)::float8 AS remaining_ms
        FROM claimed c ORDER BY c.id`;
    });
  }

  /** Claimed rows given back unsent: due now, the attempt not counted, unbound again if this claim bound them. */
  private async release(rows: readonly Claimed[], lease: string): Promise<void> {
    if (!rows.length) return;
    const unbind = rows.filter((r) => r.unbound).map((r) => r.id);
    await deliveryTransaction(this.deps.sql, (tx) => tx`
      UPDATE partner_score_events SET attempts = attempts - 1, lease_token = NULL, lease_expires_at = NULL,
        next_attempt_at = now(),
        destination = CASE WHEN id = ANY(${unbind}::bigint[]) THEN NULL ELSE destination END
      WHERE id = ANY(${rows.map((r) => r.id)}::bigint[]) AND lease_token = ${lease}::uuid`);
  }

  private async deliver(dest: DeliveryDestination, row: Claimed, lease: string, issued: number): Promise<void> {
    const url = dest.url;
    const body = JSON.stringify(scoreEventBody(row.payload));
    const headers = { 'content-type': 'application/json', 'x-api-key': dest.apiKey, 'user-agent': 'Quizball-ScoreEvents/1' };
    await this.deps.beforeSend?.(row.event_id);
    // Right before the request (nothing awaited between here and fetch), both measured from before the claim was
    // sent, so never later than the database's view: the deadline, and the whole send inside the lease.
    const now = this.clock();
    if (now >= issued + row.remaining_ms) {
      await this.expireUnsent(dest, row, lease);
      return;
    }
    if (now + this.timeoutMs + (this.deps.leaseMarginMs ?? LEASE_MARGIN_MS) > issued + this.leaseMs) {
      this.deps.log.warn({ eventId: row.event_id }, 'Partner score event given back: too little of its lease left');
      await this.release([row], lease);
      return;
    }
    const startedAt = new Date();
    const began = performance.now();
    const elapsed = () => Math.round(performance.now() - began);
    const controller = new AbortController();
    const timeout = new SendTimeout();
    const timer = setTimeout(() => controller.abort(timeout), this.timeoutMs);
    const onStop = () => controller.abort(this.stopReason);
    if (this.stopping.signal.aborted) onStop();
    else this.stopping.signal.addEventListener('abort', onStop, { once: true });
    let outcome: Outcome;
    try {
      const res = await (this.deps.fetch ?? fetch)(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
      const latencyMs = elapsed();
      const retryAfter = res.status === 429 || res.status === 503
        ? parseRetryAfter(res.headers.get('retry-after'))
        : null;
      // The body is never read or kept: the status decides the attempt.
      await res.body?.cancel().catch(() => {});
      outcome = res.status >= 100 && res.status <= 599
        ? { kind: 'answered', status: res.status, latencyMs, retryAfter }
        : { kind: 'failed', error: 'network', latencyMs };
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      outcome = { kind: 'failed', error: classifyError(reason, this.stopReason), latencyMs: elapsed() };
    } finally {
      clearTimeout(timer);
      this.stopping.signal.removeEventListener('abort', onStop);
    }
    await this.acknowledge(dest, row, lease, startedAt, outcome);
  }

  /** Claimed but its deadline passed before the request could start: dead, the attempt not counted. */
  private async expireUnsent(dest: DeliveryDestination, row: Claimed, lease: string): Promise<void> {
    const [done] = await deliveryTransaction(this.deps.sql, (tx) => tx<{ attempts: number }[]>`
      UPDATE partner_score_events SET status = 'dead', dead_at = now(), attempts = attempts - 1,
        last_error = coalesce(last_error, 'window_passed'), lease_token = NULL, lease_expires_at = NULL
      WHERE id = ${row.id}::bigint AND lease_token = ${lease}::uuid
      RETURNING attempts`);
    if (done) this.deadLettered(dest, row, done.attempts, row.last_error ?? 'window_passed');
  }

  /** Records the attempt and settles the row, both only while the lease is still this claim's. */
  private async acknowledge(
    dest: DeliveryDestination, row: Claimed, lease: string, startedAt: Date, o: Outcome,
  ): Promise<void> {
    const { log } = this.deps;
    const delivered = o.kind === 'answered' && o.status >= 200 && o.status < 300;
    const permanent = o.kind === 'answered' && isPermanentStatus(o.status);
    const aborted = o.kind === 'failed' && o.error === 'aborted';
    const lastError = attemptClassification(o);
    const retryAfter = o.kind === 'answered' ? o.retryAfter : null;
    const delayMs = retryDelayMs(row.attempts, this.deps.random, this.deps.backoffBaseMs, this.deps.backoffCapMs);
    const windowS = (this.deps.windowMs ?? RETRY_WINDOW_MS) / 1000;
    const marginMs = this.deps.lastTryMarginMs ?? LAST_TRY_MARGIN_MS;
    const settled = await deliveryTransaction(this.deps.sql, async (tx) => {
      const [target] = await tx<{ now: Date; window_end: Date }[]>`
        SELECT now() AS now, coalesce(revived_at, created_at) + make_interval(secs => ${windowS}) AS window_end
        FROM partner_score_events
        WHERE id = ${row.id}::bigint AND lease_token = ${lease}::uuid
        FOR UPDATE`;
      if (!target) return null;
      await tx`
        INSERT INTO partner_score_event_attempts
          (event_row_id, attempt, started_at, latency_ms, http_status, error)
        VALUES (${row.id}, ${row.attempts}, ${startedAt}, ${o.latencyMs},
                ${o.kind === 'answered' ? o.status : null}, ${lastError})`;
      const decision = settleDecision({
        delivered, permanent, aborted, now: target.now.getTime(), windowEnd: target.window_end.getTime(),
        delayMs, retryAfter, marginMs,
      });
      const [done] = await tx<{ status: string; attempts: number }[]>`
        UPDATE partner_score_events SET
          status = ${decision.status},
          sent_at = CASE WHEN ${decision.status} = 'sent' THEN now() ELSE sent_at END,
          dead_at = CASE WHEN ${decision.status} = 'dead' THEN now() ELSE dead_at END,
          next_attempt_at = coalesce(${decision.next}::timestamptz, next_attempt_at),
          last_error = ${lastError},
          lease_token = NULL,
          lease_expires_at = NULL
        WHERE id = ${row.id}::bigint
        RETURNING status, attempts`;
      return done ? { ...done, next: decision.next } : null;
    });
    const where = { eventId: row.event_id, partner: dest.slug, attempt: row.attempts };
    const status = o.kind === 'answered' ? o.status : null;
    if (!settled) {
      log.warn({ ...where, status, error: lastError }, 'Partner score event outcome not applied: its lease was taken over');
    } else if (settled.status === 'sent') {
      log.info({ ...where, status, latencyMs: o.latencyMs }, 'Partner score event delivered');
      this.final({ eventId: row.event_id, status: 'sent', attempts: settled.attempts, lastError: null });
    } else if (settled.status === 'dead') {
      if (status === 409) {
        log.error(
          { eventId: row.event_id, status, error: lastError },
          'Partner rejected a score event as the same eventId with a different body (409); not retried',
        );
      }
      this.deadLettered(dest, row, settled.attempts, lastError);
    } else {
      log.warn({ ...where, lastError, latencyMs: o.latencyMs, nextAttemptAt: settled.next }, 'Partner score event attempt failed');
    }
  }

  private deadLettered(dest: DeliveryDestination, row: Pick<Claimed, 'event_id'>, attempts: number, lastError: unknown) {
    this.deps.log.error(
      { eventId: row.event_id, partner: dest.slug, environment: dest.environment, attempts, lastError },
      'Partner score event dead-lettered; needs a manual resend',
    );
    this.final({ eventId: row.event_id, status: 'dead', attempts, lastError: typeof lastError === 'string' ? lastError : null });
  }

  private final(outcome: Parameters<NonNullable<ScoreEventDispatcherDeps['onFinal']>>[0]): void {
    try {
      this.deps.onFinal?.(outcome);
    } catch (error) {
      this.deps.log.warn({ err: error, eventId: outcome.eventId }, 'Partner score event outcome hook failed');
    }
  }
}
