import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import {
  auctionPipelineController,
  auctionPipelinePromptKeyParamSchema,
  auctionPipelinePromptUpdateSchema,
  auctionPipelineRequeueSchema,
} from '../../modules/auction/index.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

router.get('/stats', auctionPipelineController.getStats);

router.get('/workers', auctionPipelineController.listWorkers);

router.get('/prompts', auctionPipelineController.listPrompts);

router.put(
  '/prompts/:key',
  validate({
    params: auctionPipelinePromptKeyParamSchema,
    body: auctionPipelinePromptUpdateSchema,
  }),
  auctionPipelineController.savePrompt
);

router.delete(
  '/prompts/:key',
  validate({ params: auctionPipelinePromptKeyParamSchema }),
  auctionPipelineController.resetPrompt
);

router.post(
  '/requeue',
  validate({ body: auctionPipelineRequeueSchema }),
  auctionPipelineController.requeueTasks
);

export const adminAuctionPipelineRoutes = router;
