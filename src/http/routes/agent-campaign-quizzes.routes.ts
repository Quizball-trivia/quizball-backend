import { Router } from 'express';
import { campaignAgentAuth } from '../middleware/campaign-agent-auth.js';
import { validate } from '../middleware/validate.js';
import {
  adminCampaignQuizImageBodySchema,
  adminCampaignQuizImageGenerateBodySchema,
  agentCampaignQuizCandidateSchema,
  agentCampaignQuizCommitBodySchema,
  agentCampaignQuizDueQuerySchema,
  agentCampaignQuizReviewBodySchema,
  campaignQuizAgentController,
  campaignQuizSlugParamsSchema,
} from '../../modules/campaign-quizzes/index.js';

const router = Router();

// The quiz-page agent: its own token, only these operations. Every write goes through the same checks as the CMS.
router.use(campaignAgentAuth);

router.get('/due', validate({ query: agentCampaignQuizDueQuerySchema }), campaignQuizAgentController.due);
router.post('/validate', validate({ body: agentCampaignQuizCandidateSchema }), campaignQuizAgentController.validate);
router.post('/commit', validate({ body: agentCampaignQuizCommitBodySchema }), campaignQuizAgentController.commit);
router.post('/images', validate({ body: adminCampaignQuizImageBodySchema }), campaignQuizAgentController.uploadImage);
router.post('/images/generate', validate({ body: adminCampaignQuizImageGenerateBodySchema }), campaignQuizAgentController.generateImage);
router.get('/:slug', validate({ params: campaignQuizSlugParamsSchema }), campaignQuizAgentController.state);
router.post(
  '/:slug/review',
  validate({ params: campaignQuizSlugParamsSchema, body: agentCampaignQuizReviewBodySchema }),
  campaignQuizAgentController.review,
);

export const agentCampaignQuizzesRoutes = router;
