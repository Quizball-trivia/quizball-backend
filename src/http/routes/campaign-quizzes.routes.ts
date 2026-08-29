import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { optionalAuthMiddleware } from '../middleware/auth.js';
import {
  campaignQuizAnswerBodySchema,
  campaignQuizLocaleQuerySchema,
  campaignQuizListQuerySchema,
  campaignQuizPreviewQuerySchema,
  campaignQuizRatingBodySchema,
  campaignQuizSlugParamsSchema,
  campaignQuizzesController,
} from '../../modules/campaign-quizzes/index.js';

const router = Router();

// Public read/play routes. Correct answers are never included in the initial
// quiz response; the answer endpoint reveals one only after a selection.
router.get(
  '/',
  validate({ query: campaignQuizListQuerySchema }),
  campaignQuizzesController.list,
);

router.get(
  '/routes/:slug',
  validate({ params: campaignQuizSlugParamsSchema }),
  campaignQuizzesController.resolveRoute,
);

router.get(
  '/:slug',
  validate({
    params: campaignQuizSlugParamsSchema,
    query: campaignQuizPreviewQuerySchema,
  }),
  campaignQuizzesController.getQuiz,
);

router.post(
  '/:slug/answers',
  validate({
    params: campaignQuizSlugParamsSchema,
    query: campaignQuizLocaleQuerySchema,
    body: campaignQuizAnswerBodySchema,
  }),
  campaignQuizzesController.answer,
);

// Ratings do not require an account: signed-in visitors get one rating per
// user, guests one per hashed client address.
router.put(
  '/:slug/rating',
  optionalAuthMiddleware,
  validate({
    params: campaignQuizSlugParamsSchema,
    body: campaignQuizRatingBodySchema,
  }),
  campaignQuizzesController.rate,
);

export const campaignQuizzesRoutes = router;
