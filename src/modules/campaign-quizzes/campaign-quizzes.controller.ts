import type { Request, Response } from 'express';
import { AuthenticationError } from '../../core/errors.js';
import type {
  CampaignQuizAnswerBody,
  CampaignQuizRatingBody,
  CampaignQuizSlugParams,
} from './campaign-quizzes.schemas.js';
import { campaignQuizzesService } from './campaign-quizzes.service.js';

export const campaignQuizzesController = {
  async getQuiz(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    res.json(await campaignQuizzesService.getQuiz(slug));
  },

  async answer(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    const body = req.validated.body as CampaignQuizAnswerBody;
    res.json(
      await campaignQuizzesService.answer(
        slug,
        body.question_id,
        body.selected_option_id,
      ),
    );
  },

  async rate(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    const { rating } = req.validated.body as CampaignQuizRatingBody;
    if (!req.user) throw new AuthenticationError();
    res.json(await campaignQuizzesService.rate(slug, req.user.id, rating));
  },
};
