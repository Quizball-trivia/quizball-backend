import { AppError, ErrorCode } from '../../core/errors.js';

export const contentChanged = (): AppError =>
  new AppError('content_changed', 409, ErrorCode.BUSCAMINAS_CONTENT_CHANGED, { reason: 'content_changed' });

export const staleState = (): AppError =>
  new AppError('stale_state', 409, ErrorCode.BUSCAMINAS_STALE_STATE, { reason: 'stale_state' });

export const dayOver = (): AppError =>
  new AppError('day_over', 409, ErrorCode.BUSCAMINAS_DAY_OVER, { reason: 'day_over' });

export const tooManyRuns = (): AppError =>
  new AppError('too_many_runs', 429, ErrorCode.BUSCAMINAS_TOO_MANY_RUNS, { reason: 'too_many_runs' });

export const signInForToday = (): AppError =>
  new AppError('sign_in_for_today', 403, ErrorCode.BUSCAMINAS_SIGN_IN_FOR_TODAY, { reason: 'sign_in_for_today' });

export const disabled = (): AppError => new AppError('Buscaminas is currently disabled', 503, ErrorCode.BUSCAMINAS_DISABLED);

/** Redis (run ledger / start counter) failed or stalled: retryable, and never reported as a database error. */
export const unavailable = (): AppError =>
  new AppError('Buscaminas is temporarily unavailable', 503, ErrorCode.BUSCAMINAS_UNAVAILABLE, { reason: 'unavailable' });
