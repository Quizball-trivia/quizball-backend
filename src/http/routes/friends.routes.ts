import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createFriendRequestBodySchema,
  friendRequestIdParamSchema,
  friendUserIdParamSchema,
  friendsController,
} from '../../modules/friends/index.js';

const router = Router();

router.use(authMiddleware);

router.get('/', friendsController.listFriends);
router.get('/requests', friendsController.listRequests);
router.post(
  '/requests',
  validate({ body: createFriendRequestBodySchema }),
  friendsController.createRequest
);
router.post(
  '/requests/:requestId/accept',
  validate({ params: friendRequestIdParamSchema }),
  friendsController.acceptRequest
);
router.post(
  '/requests/:requestId/decline',
  validate({ params: friendRequestIdParamSchema }),
  friendsController.declineRequest
);
router.delete(
  '/:friendUserId',
  validate({ params: friendUserIdParamSchema }),
  friendsController.removeFriend
);

export const friendsRoutes = router;
