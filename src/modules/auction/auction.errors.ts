import { AppError } from '../../core/errors.js';

export const AuctionContentErrorCode = {
  CONTENT_UNAVAILABLE: 'auction_content_unavailable',
  STARTING_PRICE_UNAVAILABLE: 'auction_starting_price_unavailable',
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
    super('Published auction content unavailable', AuctionContentErrorCode.CONTENT_UNAVAILABLE, details);
  }
}

export class AuctionStartingPriceUnavailableError extends AuctionContentError {
  constructor(details: unknown = null) {
    super(
      'Published auction content is missing auction price fields',
      AuctionContentErrorCode.STARTING_PRICE_UNAVAILABLE,
      details
    );
  }
}
