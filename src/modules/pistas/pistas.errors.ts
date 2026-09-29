import { AppError, BadRequestError, ErrorCode } from '../../core/errors.js';

export const contentChanged = (): AppError =>
  new AppError('content_changed', 409, ErrorCode.PISTAS_CONTENT_CHANGED, { reason: 'content_changed' });

export const staleState = (): AppError =>
  new AppError('stale_state', 409, ErrorCode.PISTAS_STALE_STATE, { reason: 'stale_state' });

export const dayOver = (): AppError =>
  new AppError('day_over', 409, ErrorCode.PISTAS_DAY_OVER, { reason: 'day_over' });

export const signInForToday = (): AppError =>
  new AppError('sign_in_for_today', 403, ErrorCode.PISTAS_SIGN_IN_FOR_TODAY, { reason: 'sign_in_for_today' });

export const guestSessionRequired = (): AppError =>
  new AppError('guest_session_required', 401, ErrorCode.PISTAS_GUEST_SESSION_REQUIRED, { reason: 'guest_session_required' });

export const notYourRun = (): AppError =>
  new AppError('run_not_yours', 403, ErrorCode.AUTHORIZATION_ERROR, { reason: 'run_not_yours' });

/** A move the run's state does not allow: run_done, round_settled, round_not_settled, no_more_clues, guess_limit. */
export const rejected = (reason: string): BadRequestError => new BadRequestError(reason, { reason });
