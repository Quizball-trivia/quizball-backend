import type { ErrorRequestHandler, Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { logger } from '../../core/logger.js';
import { isTransientDatabaseError } from '../../http/middleware/error-handler.js';

/** Stable codes on the wire (external contract §3, internal API §1–2). */
export type PartnerErrorCode =
  | 'invalid_request'
  | 'token_expired'
  | 'token_used'
  | 'token_unknown'
  | 'unknown_key'
  | 'ip_not_allowed'
  | 'player_blocked'
  | 'request_conflict'
  | 'request_used'
  | 'rate_limited'
  | 'maintenance'
  | 'internal_error'
  | 'partner_session_required'
  | 'session_ended'
  | 'unknown_player'
  | 'game_not_available'
  | 'quota_exhausted'
  | 'play_not_active'
  | 'stale_version'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'staff_exists'
  | 'staff_not_eligible'
  | 'invite_failed';

const STATUS: Record<PartnerErrorCode, number> = {
  invalid_request: 400,
  token_expired: 400,
  token_used: 400,
  token_unknown: 400,
  unknown_key: 401,
  ip_not_allowed: 403,
  player_blocked: 403,
  request_conflict: 409,
  request_used: 409,
  rate_limited: 429,
  maintenance: 503,
  internal_error: 500,
  partner_session_required: 401,
  session_ended: 401,
  unknown_player: 404,
  game_not_available: 409,
  quota_exhausted: 409,
  play_not_active: 409,
  stale_version: 409,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  staff_exists: 409,
  staff_not_eligible: 409,
  invite_failed: 502,
};

const MESSAGES: Record<PartnerErrorCode, string> = {
  invalid_request: 'A field is missing or invalid',
  token_expired: 'Launch token has expired',
  token_used: 'Launch token has already been used',
  token_unknown: 'Launch token is not known',
  unknown_key: 'Missing or wrong x-api-key',
  ip_not_allowed: 'Caller IP is not on the allowlist',
  player_blocked: 'The player is blocked',
  request_conflict: 'This requestId was already used with different field values',
  request_used: 'This requestId belongs to a launch that was already used or has expired; send a new requestId',
  rate_limited: 'Too many requests',
  maintenance: 'Temporarily unavailable',
  internal_error: 'Unexpected error',
  partner_session_required: 'A partner session is required',
  session_ended: 'The session has ended; open again from the partner',
  unknown_player: 'Player not found',
  game_not_available: 'This game is not available',
  quota_exhausted: 'No plays left today for this game',
  play_not_active: 'This play is no longer active',
  stale_version: 'Someone saved in between; reload and try again',
  unauthorized: 'Sign in again',
  forbidden: 'Not allowed',
  not_found: 'Not found',
  staff_exists: 'This person is already a staff member',
  staff_not_eligible: 'This account cannot be made partner staff',
  invite_failed: 'The invite could not be sent; try again',
};

export class PartnerError extends Error {
  readonly status: number;
  constructor(
    readonly code: PartnerErrorCode,
    message: string = MESSAGES[code],
    readonly retryAfterSeconds?: number,
    /** Why a session ended ('replaced', 'blocked', 'expired'), for the web view's relaunch message. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'PartnerError';
    this.status = STATUS[code];
  }
}

export function sendPartnerError(res: Response, error: PartnerError): void {
  if (error.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(error.retryAfterSeconds));
  res.setHeader('Cache-Control', 'no-store');
  res.status(error.status).json({
    error: { code: error.code, message: error.message, ...(error.reason ? { reason: error.reason } : {}) },
  });
}

/** Partner routers answer in the partner format `{ error: { code, message } }`, never the Quizball one. */
export const partnerErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof PartnerError) return sendPartnerError(res, err);
  if (err instanceof ZodError) return sendPartnerError(res, new PartnerError('invalid_request'));
  // Express could not decode a route parameter (malformed %-encoding in :playerId).
  if (err instanceof URIError) return sendPartnerError(res, new PartnerError('invalid_request', 'A path parameter is not valid'));
  // body-parser: malformed JSON, too large, wrong charset (raised before any partner router runs).
  const parserStatus = (err as { type?: unknown; status?: unknown }).type !== undefined
    ? (err as { status?: unknown }).status
    : undefined;
  if (typeof parserStatus === 'number' && parserStatus >= 400 && parserStatus < 500) {
    return sendPartnerError(res, new PartnerError('invalid_request', 'The body is not valid JSON'));
  }
  if (isTransientDatabaseError(err)) {
    logger.warn({ err, path: req.path }, 'Partner request: transient database failure');
    return sendPartnerError(res, new PartnerError('maintenance', undefined, 1));
  }
  logger.error({ err, path: req.path }, 'Partner request failed');
  sendPartnerError(res, new PartnerError('internal_error'));
};

export function parsePartnerInput<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PartnerError('invalid_request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : undefined);
  }
  return parsed.data;
}

/** Paths whose errors use the partner format, wherever they are raised (app-level body parsing included). */
export function isPartnerPath(originalUrl: string): boolean {
  return /^\/partner(-admin)?\/v1(\/|$|\?)/.test(originalUrl);
}
