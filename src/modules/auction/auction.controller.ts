import type { Request, Response } from 'express';
import { auctionService } from './auction.service.js';
import type {
  AuctionCardIdParam,
  ListAuctionCardsQuery,
  UpdateAuctionCardRequest,
  UpdateAuctionCardStatusRequest,
} from './auction.schemas.js';

/**
 * Admin Auction controller. Translates HTTP ↔ service calls. No business logic.
 */
export const auctionController = {
  async listCards(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as ListAuctionCardsQuery;
    const result = await auctionService.listCards(
      {
        status: query.status,
        positionGroup: query.position_group,
        cardType: query.card_type,
        difficulty: query.difficulty,
        fameBucket: query.fame_bucket,
        verificationStatus: query.verification_status,
        search: query.search,
      },
      query.page,
      query.limit
    );

    res.json(result);
  },

  async getCardById(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as AuctionCardIdParam;
    const result = await auctionService.getCardById(id);
    res.json(result);
  },

  async updateCard(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as AuctionCardIdParam;
    const body = req.validated.body as UpdateAuctionCardRequest;
    const result = await auctionService.updateCard(id, body);
    res.json(result);
  },

  async updateStatus(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as AuctionCardIdParam;
    const body = req.validated.body as UpdateAuctionCardStatusRequest;
    const result = await auctionService.updateStatus(id, body, req.user?.id);
    res.json(result);
  },
};
