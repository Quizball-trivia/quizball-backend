import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { objectivesController } from '../../modules/objectives/index.js';

const router = Router();

router.use(authMiddleware);

router.get('/', objectivesController.list);

export const objectivesRoutes = router;
