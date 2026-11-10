import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import {
  contentGapsAdminController, gapIdParamSchema, listGapsQuerySchema, updateGapBodySchema,
} from '../../modules/content-gaps/content-gaps.admin.js';

// Admin-only: typed answers games could not judge well (CMS HQ → Content gaps, and the Content Fixer agent).
const router = Router();
router.use(authMiddleware, requireRole('admin'));

router.get('/', validate({ query: listGapsQuerySchema }), contentGapsAdminController.list);
router.get('/summary', contentGapsAdminController.summary);
router.patch('/:id', validate({ params: gapIdParamSchema, body: updateGapBodySchema }), contentGapsAdminController.update);

export const adminContentGapsRoutes = router;
