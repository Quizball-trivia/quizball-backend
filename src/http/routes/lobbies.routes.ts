import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  lobbiesController,
  listPublicLobbiesQuerySchema,
} from '../../modules/lobbies/index.js';

const router = Router();

router.use(authMiddleware);

/**
 * GET /api/v1/lobbies/public
 * List public lobbies.
 */
router.get(
  '/public',
  validate({ query: listPublicLobbiesQuerySchema }),
  lobbiesController.listPublic
);

export const lobbiesRoutes = router;
