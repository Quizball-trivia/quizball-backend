/**
 * Internal telemetry endpoint for the rubber-band governor (PR9, §1.10).
 *
 * Deliberately MINIMAL — one read-only GET returning the daily bot-vs-human
 * win/loss aggregate plus a summary of current governor offsets. The CMS screen
 * that renders this is PR10; this exists so the staging soak (the flag-on gate
 * precondition) can be verified without a psql session.
 *
 * Auth reuses the ops shared-secret pattern (x-ops-report-token): this is
 * machine/operator tooling, not a user-facing surface, and it fails closed when
 * OPS_REPORT_TOKEN is unset.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../../../core/config.js';
import { AuthenticationError, InternalError } from '../../../core/errors.js';
import { getGovernorTelemetry } from './governor.service.js';
import type { GovernorTelemetryQuery } from './governor.schemas.js';

const OPS_TOKEN_HEADER = 'x-ops-report-token';

function secretsMatch(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  // timingSafeEqual throws on unequal lengths; an unequal length is itself a
  // mismatch, so guard before comparing rather than leaking via the throw.
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function assertOpsAuthorized(req: Request): void {
  if (!config.OPS_REPORT_TOKEN) {
    throw new InternalError('Governor telemetry endpoint is not configured (OPS_REPORT_TOKEN unset)');
  }
  const provided = getHeaderValue(req.headers[OPS_TOKEN_HEADER]);
  if (!secretsMatch(config.OPS_REPORT_TOKEN, provided)) {
    throw new AuthenticationError('Invalid ops token');
  }
}

export const governorController = {
  async getTelemetry(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    const { days } = req.validated.query as GovernorTelemetryQuery;
    res.json(await getGovernorTelemetry(days));
  },
};
