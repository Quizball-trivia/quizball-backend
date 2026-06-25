import { AppError, ErrorCode } from '../../core/errors.js';

export const AuctionContentErrorCode = {
  CONTENT_UNAVAILABLE: ErrorCode.AUCTION_CONTENT_UNAVAILABLE,
  STARTING_PRICE_UNAVAILABLE: ErrorCode.AUCTION_STARTING_PRICE_UNAVAILABLE,
} as const;

export type AuctionContentErrorCodeType =
  (typeof AuctionContentErrorCode)[keyof typeof AuctionContentErrorCode];

export class AuctionContentError extends AppError {
  public readonly auctionCode: AuctionContentErrorCodeType;

  constructor(message: string, auctionCode: AuctionContentErrorCodeType, details: unknown = null) {
    super(message, 404, auctionCode, details);
    this.auctionCode = auctionCode;
  }
}

export class AuctionContentUnavailableError extends AuctionContentError {
  constructor(details: unknown = null) {
    super('Published auction content unavailable', ErrorCode.AUCTION_CONTENT_UNAVAILABLE, details);
  }
}

export class AuctionStartingPriceUnavailableError extends AuctionContentError {
  constructor(details: unknown = null) {
    super(
      'Published auction content is missing auction price fields',
      ErrorCode.AUCTION_STARTING_PRICE_UNAVAILABLE,
      details
    );
  }
}
