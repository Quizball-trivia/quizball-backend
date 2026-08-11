import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../../core/config.js';
import { AuthenticationError, InternalError } from '../../core/errors.js';
import { opsService } from './ops.service.js';
import { clueGuessEvaluationsRepo } from '../matches/clue-guess-evaluations.repo.js';
import { readOnlyDbBreaker, READ_ONLY_SQLSTATE } from '../../db/readonly-breaker.js';
import { buildSystemStatus } from '../../realtime/services/system-status.service.js';
import type { ClueGuessQuery, DailyReportEmailBody } from './ops.schemas.js';

const OPS_TOKEN_HEADER = 'x-ops-report-token';

function secretsMatch(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  // timingSafeEqual requires equal-length buffers; an unequal length is itself
  // a mismatch, so guard before comparing to avoid the length leak it throws on.
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/**
 * Reject the request unless it carries the shared ops token. Fails closed:
 * if OPS_REPORT_TOKEN is unset the endpoint cannot be used at all (no
 * accidental unauthenticated send path).
 */
function assertOpsAuthorized(req: Request): void {
  if (!config.OPS_REPORT_TOKEN) {
    throw new InternalError('Ops report endpoint is not configured (OPS_REPORT_TOKEN unset)');
  }
  const provided = getHeaderValue(req.headers[OPS_TOKEN_HEADER]);
  if (!secretsMatch(config.OPS_REPORT_TOKEN, provided)) {
    throw new AuthenticationError('Invalid ops report token');
  }
}

/**
 * Second, independent guard for the outage-simulation endpoints. Returns true
 * ONLY for the explicit non-prod environments. Deliberately an allowlist, not
 * `!== 'prod'`: NODE_ENV defaults to 'local' when unset, so a negative check
 * would fail OPEN on a prod deploy that forgot to set NODE_ENV. The force-
 * degrade demo trips the REAL breaker (pausing matchmaking), so it must be
 * impossible to fire anywhere but staging/local no matter the token.
 */
function isOutageSimAllowed(): boolean {
  return config.NODE_ENV === 'staging' || config.NODE_ENV === 'local';
}

export const opsController = {
  async sendDailyReport(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    const body = req.validated.body as DailyReportEmailBody;
    const result = await opsService.sendDailyReportEmail(body);
    res.json({ ok: true, emailId: result.id });
  },

  /**
   * Recent clue-guess evaluations for the rejection investigation. Same shared
   * ops token as the report relay — this returns free text players typed, so it
   * must never be reachable with a user JWT.
   */
  async listClueGuesses(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    const query = req.validated.query as ClueGuessQuery;
    const rows = await clueGuessEvaluationsRepo.listRecent({
      questionId: query.questionId,
      userId: query.userId,
      matchId: query.matchId,
      rejectsOnly: query.rejectsOnly !== 'false',
      excludeAi: query.includeAi !== 'true',
      limit: query.limit,
    });
    res.json({ ok: true, count: rows.length, rows });
  },

  /**
   * STAGING-ONLY: simulate a read-only DB outage to exercise the real
   * degraded-mode UX end to end. Feeds a synthetic 25006 into the actual
   * breaker trip path — the SAME code an INC-2026-07-29 recurrence would hit —
   * so matchmaking pauses and system:status broadcasts for real. Touches NO
   * database (the breaker is pure in-memory bookkeeping).
   *
   * Double-guarded: shared ops token AND a staging/local allowlist (403 else).
   */
  async forceDegrade(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    if (!isOutageSimAllowed()) {
      res.status(403).json({ ok: false, error: 'force-degrade is disabled on production' });
      return;
    }
    // Synthetic error shaped exactly like the pg read-only failure. Goes through
    // recordError → the genuine first-trip branch (logger.fatal + edge emit).
    const synthetic = Object.assign(new Error('synthetic read-only outage (ops force-degrade)'), {
      code: READ_ONLY_SQLSTATE,
    });
    readOnlyDbBreaker.recordError(synthetic, { source: 'ops_force_degrade' });
    res.json({ ok: true, status: buildSystemStatus() });
  },

  /**
   * STAGING-ONLY: clear a force-degraded latch immediately so the demo can show
   * the "Back online" recovery pulse without waiting out the probe window.
   * Prod recovery is probe-driven only; this path is prod-guarded (403).
   */
  async forceRecover(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    if (!isOutageSimAllowed()) {
      res.status(403).json({ ok: false, error: 'force-recover is disabled on production' });
      return;
    }
    // forceRecover fires the recovery edge itself (→ system:status broadcast)
    // only when it was actually degraded. Do NOT emit again here: a second
    // broadcast would double-fire on real recovery and spuriously broadcast on
    // a no-op (already-healthy) call. The HTTP response still echoes the truth.
    readOnlyDbBreaker.forceRecover();
    res.json({ ok: true, status: buildSystemStatus() });
  },
};
