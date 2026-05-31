import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../../core/config.js';
import { AuthenticationError, InternalError } from '../../core/errors.js';
import { opsService } from './ops.service.js';
import type { DailyReportEmailBody } from './ops.schemas.js';

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

export const opsController = {
  async sendDailyReport(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    const body = req.validated.body as DailyReportEmailBody;
    const result = await opsService.sendDailyReportEmail(body);
    res.json({ ok: true, emailId: result.id });
  },
};
