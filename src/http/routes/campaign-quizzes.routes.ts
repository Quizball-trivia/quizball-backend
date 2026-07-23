import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  campaignQuizAnswerBodySchema,
  campaignQuizRatingBodySchema,
  campaignQuizSlugParamsSchema,
  campaignQuizzesController,
} from '../../modules/campaign-quizzes/index.js';

const router = Router();

// Public read/play routes. Correct answers are never included in the initial
// quiz response; the answer endpoint reveals one only after a selection.
router.get(
  '/:slug',
  validate({ params: campaignQuizSlugParamsSchema }),
  campaignQuizzesController.getQuiz,
);

router.post(
  '/:slug/answers',
  validate({
    params: campaignQuizSlugParamsSchema,
    body: campaignQuizAnswerBodySchema,
  }),
  campaignQuizzesController.answer,
);

// Ratings are account-bound: one current rating per user and quiz.
router.put(
  '/:slug/rating',
  authMiddleware,
  validate({
    params: campaignQuizSlugParamsSchema,
    body: campaignQuizRatingBodySchema,
  }),
  campaignQuizzesController.rate,
);

export const campaignQuizzesRoutes = router;
