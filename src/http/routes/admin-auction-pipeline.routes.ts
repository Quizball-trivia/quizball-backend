import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { auctionPipelineController } from '../../modules/auction/index.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

router.get('/stats', auctionPipelineController.getStats);

export const adminAuctionPipelineRoutes = router;
