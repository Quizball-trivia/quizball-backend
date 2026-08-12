import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { validate } from '../middleware/validate.js';
import {
  adminCampaignQuizImageBodySchema,
  adminCampaignQuizHubOrderBodySchema,
  adminCampaignQuizListQuerySchema,
  adminCampaignQuizPageBodySchema,
  adminCampaignQuizPublishBodySchema,
  adminCampaignQuizRetireBodySchema,
  adminCampaignQuizzesController,
  campaignQuizSlugParamsSchema,
  adminCampaignQuizRevisionParamsSchema,
} from '../../modules/campaign-quizzes/index.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

router.get(
  '/',
  validate({ query: adminCampaignQuizListQuerySchema }),
  adminCampaignQuizzesController.list,
);

router.get('/question-sets', adminCampaignQuizzesController.listQuestionSets);
router.get('/search-console', adminCampaignQuizzesController.searchConsole);

router.patch(
  '/hub-order',
  validate({ body: adminCampaignQuizHubOrderBodySchema }),
  adminCampaignQuizzesController.updateHubOrder,
);

router.post(
  '/images',
  validate({ body: adminCampaignQuizImageBodySchema }),
  adminCampaignQuizzesController.uploadImage,
);

router.post(
  '/',
  validate({ body: adminCampaignQuizPageBodySchema }),
  adminCampaignQuizzesController.create,
);

router.get(
  '/:slug',
  validate({ params: campaignQuizSlugParamsSchema }),
  adminCampaignQuizzesController.get,
);

router.put(
  '/:slug',
  validate({
    params: campaignQuizSlugParamsSchema,
    body: adminCampaignQuizPageBodySchema,
  }),
  adminCampaignQuizzesController.update,
);

router.post(
  '/:slug/preview',
  validate({ params: campaignQuizSlugParamsSchema }),
  adminCampaignQuizzesController.preview,
);

router.get(
  '/:slug/googlebot',
  validate({ params: campaignQuizSlugParamsSchema }),
  adminCampaignQuizzesController.googlebot,
);

router.get(
  '/:slug/revisions',
  validate({ params: campaignQuizSlugParamsSchema }),
  adminCampaignQuizzesController.listRevisions,
);

router.post(
  '/:slug/revisions/:revisionId/restore',
  validate({ params: adminCampaignQuizRevisionParamsSchema }),
  adminCampaignQuizzesController.restoreRevision,
);

router.post(
  '/:slug/publish',
  validate({
    params: campaignQuizSlugParamsSchema,
    body: adminCampaignQuizPublishBodySchema,
  }),
  adminCampaignQuizzesController.publish,
);

router.post(
  '/:slug/unpublish',
  validate({
    params: campaignQuizSlugParamsSchema,
    body: adminCampaignQuizRetireBodySchema,
  }),
  adminCampaignQuizzesController.unpublish,
);

router.delete(
  '/:slug',
  validate({
    params: campaignQuizSlugParamsSchema,
    body: adminCampaignQuizRetireBodySchema,
  }),
  adminCampaignQuizzesController.remove,
);

export const adminCampaignQuizzesRoutes = router;
