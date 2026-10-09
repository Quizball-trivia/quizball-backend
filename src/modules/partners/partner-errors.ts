import type { ErrorRequestHandler, Request, Response } from 'express';
import { ZodArray, ZodDefault, ZodEffects, ZodError, ZodNullable, ZodObject, ZodOptional, type ZodIssue, type ZodType, type ZodTypeAny } from 'zod';
import { AppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { isTransientDatabaseError } from '../../http/middleware/error-handler.js';
import { deployPartner, partnerCaller, routePattern, trackPartnerRefusal } from './partner-refusals.js';

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

  /** For our logs only, never sent: which input field failed validation. */
  invalidInput?: InvalidInput;
}

export type InvalidInput = { field: string; issue: string; expected?: string; received?: string };

/** An invalid_request that also tells our logs which field it was about. */
export function invalidInputError(message: string | undefined, invalid: InvalidInput): PartnerError {
  const error = new PartnerError('invalid_request', message);
  error.invalidInput = invalid;
  return error;
}

/** The issue's path with only names the schema itself declares; anything else (a caller-chosen record key, a
 *  refinement's custom path) could be the caller's own text and is masked. */
function schemaField(schema: ZodTypeAny | undefined, path: ReadonlyArray<string | number>): string {
  const parts: string[] = [];
  let node = schema;
  for (const part of path) {
    for (;;) {
      if (node instanceof ZodEffects) node = node.innerType();
      else if (node instanceof ZodDefault) node = node.removeDefault();
      else if (node instanceof ZodOptional || node instanceof ZodNullable) node = node.unwrap();
      else break;
    }
    if (node instanceof ZodObject && typeof part === 'string' && Object.hasOwn(node.shape, part)) {
      parts.push(part);
      node = node.shape[part];
    } else if (node instanceof ZodArray && typeof part === 'number') {
      parts.push(String(part));
      node = node.element;
    } else {
      parts.push('?');
      node = undefined;
    }
  }
  return parts.join('.') || 'body';
}

/** Zod's failure kind and type names. Its messages quote the input, so they stay out of the logs. */
function describeIssue(issue: ZodIssue | undefined, schema?: ZodTypeAny): InvalidInput {
  if (!issue) return { field: 'body', issue: 'invalid' };
  try {
    const field = schemaField(schema, issue.path);
    if (issue.code === 'invalid_type') return { field, issue: issue.code, expected: issue.expected, received: issue.received };
    if (issue.code === 'invalid_string' && typeof issue.validation === 'string') return { field, issue: `${issue.code}:${issue.validation}` };
    return { field, issue: issue.code };
  } catch {
    // Describing a refusal for the logs must never turn the 400 into a 500.
    return { field: '?', issue: 'invalid' };
  }
}

const LOGGED_CONTENT_TYPES = new Set(['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);

/** body-parser's own failure names; any other error can carry a `type` too, so only these are logged. */
const BODY_PARSER_FAILURES = new Set(['entity.parse.failed', 'entity.too.large', 'charset.unsupported', 'encoding.unsupported', 'request.aborted', 'parameters.too.many']);

function logInvalidInput(req: Request, invalid: InvalidInput): void {
  try {
    // A body sent as an unparsed content type fails as "first field missing", so the type is the useful clue.
    const mediaType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const contentType = mediaType === '' ? 'none' : LOGGED_CONTENT_TYPES.has(mediaType) ? mediaType : 'other';
    // The route pattern, not the URL: a URL carries caller text (ids, anything at all before a route matches).
    const route = routePattern(req);
    logger.warn({ reason: 'invalid_request', ...(route ? { route } : {}), contentType, ...invalid }, 'Partner request refused');
    const caller = partnerCaller(req);
    // A player's refused move ("tile already open") is ordinary play; the partner's server sending us a body we
    // refuse, or our own web view sending a malformed one, is an integration fault.
    if (caller && (caller.caller === 'machine' || (invalid.issue !== 'rule' && invalid.issue !== 'refused'))) {
      trackPartnerRefusal({ ...caller, reason: 'invalid_request', status: STATUS.invalid_request, route, contentType, field: invalid.field, issue: invalid.issue });
    }
  } catch {
    // Reporting is best effort; the caller still gets the 400.
  }
}

/** A partner request we failed (5xx), or a fault of the partner's server worth knowing about. `ours` also reports a
 *  request nobody signed, under the deploy's partner — a deploy with no partner configured reports nothing. */
function trackPartnerFault(req: Request, error: PartnerError, ours: boolean): void {
  try {
    const caller = partnerCaller(req) ?? (ours ? deployPartner(req) : null);
    if (caller) trackPartnerRefusal({ ...caller, reason: error.code, status: error.status, route: routePattern(req) });
  } catch {
    // Reporting is best effort; the caller still gets its answer.
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
  if (err instanceof PartnerError) {
    if (err.code === 'invalid_request') logInvalidInput(req, err.invalidInput ?? { field: '?', issue: 'rule' });
    else if (err.status >= 500) trackPartnerFault(req, err, true);
    // The partner's server reusing a requestId breaks that launch without anyone noticing.
    else if (req.partnerMachine && (err.code === 'request_conflict' || err.code === 'request_used')) trackPartnerFault(req, err, false);
    return sendPartnerError(res, err);
  }
  if (err instanceof ZodError) {
    logInvalidInput(req, describeIssue(err.issues[0]));
    return sendPartnerError(res, new PartnerError('invalid_request'));
  }
  // Express could not decode a route parameter (malformed %-encoding in :playerId).
  if (err instanceof URIError) {
    logInvalidInput(req, { field: 'path', issue: 'encoding' });
    return sendPartnerError(res, new PartnerError('invalid_request', 'A path parameter is not valid'));
  }
  // body-parser: malformed JSON, too large, wrong charset (raised before any partner router runs).
  const parserStatus = (err as { type?: unknown; status?: unknown }).type !== undefined
    ? (err as { status?: unknown }).status
    : undefined;
  if (typeof parserStatus === 'number' && parserStatus >= 400 && parserStatus < 500) {
    const failure = (err as { type?: unknown }).type;
    logInvalidInput(req, { field: 'body', issue: typeof failure === 'string' && BODY_PARSER_FAILURES.has(failure) ? failure : 'unreadable' });
    return sendPartnerError(res, new PartnerError('invalid_request', 'The body is not valid JSON'));
  }
  // A shared Quizball middleware refused the request (validation, auth): same status, partner format.
  if (err instanceof AppError && err.statusCode < 500) {
    const code: PartnerErrorCode =
      err.statusCode === 401 ? 'unauthorized'
      : err.statusCode === 403 ? 'forbidden'
      : err.statusCode === 404 ? 'not_found'
      : err.statusCode === 429 ? 'rate_limited'
      : 'invalid_request';
    if (code === 'invalid_request') logInvalidInput(req, { field: '?', issue: 'refused' });
    return sendPartnerError(res, new PartnerError(code));
  }
  if (isTransientDatabaseError(err)) {
    logger.warn({ err, path: req.path }, 'Partner request: transient database failure');
    const unavailable = new PartnerError('maintenance', undefined, 1);
    trackPartnerFault(req, unavailable, true);
    return sendPartnerError(res, unavailable);
  }
  logger.error({ err, path: req.path }, 'Partner request failed');
  const failed = new PartnerError('internal_error');
  trackPartnerFault(req, failed, true);
  sendPartnerError(res, failed);
};

export function parsePartnerInput<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalidInputError(issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : undefined, describeIssue(issue, schema));
  }
  return parsed.data;
}

/** Paths whose errors use the partner format, wherever they are raised (app-level body parsing included). */
export function isPartnerPath(originalUrl: string): boolean {
  return /^\/partner(-admin)?\/v1(\/|$|\?)/.test(originalUrl);
}
