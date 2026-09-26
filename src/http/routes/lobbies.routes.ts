import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import {
  lobbiesController,
  listPublicLobbiesQuerySchema,
} from '../../modules/lobbies/index.js';

const router = Router();

/**
 * GET /api/v1/lobbies/public
 * List public lobbies. Public by nature: the handler reads no caller and the
 * blanket auth 401'd every logged-out visitor of the friend-lobby browser
 * (189 errors on 2026-09-26 alone — the top API error after the identical
 * hall-of-fame fix in #745/#746). Optional auth still populates req.user.
 */
router.get(
  '/public',
  optionalAuthMiddleware,
  validate({ query: listPublicLobbiesQuerySchema }),
  lobbiesController.listPublic
);

router.use(authMiddleware);

export const lobbiesRoutes = router;
