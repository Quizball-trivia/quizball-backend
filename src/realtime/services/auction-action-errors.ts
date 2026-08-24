import { ErrorCode } from '../../core/errors.js';
import { AuctionContentError } from '../../modules/auction/index.js';
import { AuctionInvalidActionError } from '../../modules/auction/auction-engine.js';
import type { QuizballSocket } from '../socket-server.js';
import type { AuctionErrorPayload } from '../socket.types.js';

export class AuctionActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly meta?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export interface AuctionErrorPayloadOptions {
  fallbackCode?: string;
  fallbackMessage?: string;
}

export function emitAuctionError(socket: QuizballSocket, payload: AuctionErrorPayload): void {
  socket.emit('auction:error', payload);
}

export function toAuctionErrorPayload(
  error: unknown,
  options: AuctionErrorPayloadOptions = {}
): AuctionErrorPayload {
  if (error instanceof AuctionActionError) {
    return {
      code: error.code,
      message: error.message,
      meta: error.meta,
    };
  }
  if (error instanceof AuctionInvalidActionError) {
    return {
      code: 'auction_invalid_action',
      message: error.message,
    };
  }
  if (error instanceof AuctionContentError) {
    return {
      code: error.auctionCode,
      message: error.message,
      meta: error.details && typeof error.details === 'object'
        ? error.details as Record<string, unknown>
        : undefined,
    };
  }

  return {
    code: options.fallbackCode ?? 'auction_action_failed',
    message: error instanceof Error
      ? error.message
      : options.fallbackMessage ?? 'Auction action failed',
  };
}

export function authenticationRequiredError(): AuctionActionError {
  return new AuctionActionError(ErrorCode.AUTHENTICATION_ERROR, 'Authentication required');
}
