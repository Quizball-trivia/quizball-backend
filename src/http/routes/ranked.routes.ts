import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { rankedController } from '../../modules/ranked/ranked.controller.js';

const router = Router();

router.use(authMiddleware);

/**
 * GET /api/v1/ranked/profile
 * Get the authenticated user's ranked profile (RP, tier, placement status).
 */
router.get('/profile', rankedController.getProfile);

export const rankedRoutes = router;
