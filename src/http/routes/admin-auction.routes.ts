import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import {
  auctionCardIdParamSchema,
  auctionController,
  listAuctionCardsQuerySchema,
  updateAuctionCardSchema,
  updateAuctionCardStatusSchema,
} from '../../modules/auction/index.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

router.get(
  '/cards',
  validate({ query: listAuctionCardsQuerySchema }),
  auctionController.listCards
);

router.get(
  '/cards/:id',
  validate({ params: auctionCardIdParamSchema }),
  auctionController.getCardById
);

router.patch(
  '/cards/:id',
  validate({ params: auctionCardIdParamSchema, body: updateAuctionCardSchema }),
  auctionController.updateCard
);

router.patch(
  '/cards/:id/status',
  validate({ params: auctionCardIdParamSchema, body: updateAuctionCardStatusSchema }),
  auctionController.updateStatus
);

export const adminAuctionRoutes = router;
