import type { Request, Response } from 'express';
import { resolveTrustedClientIp } from '../../http/client-ip.js';
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

    // These pages are playable without an account, so ratings are too. A
    // signed-in rating stays account-bound; a guest rating is keyed by a
    // hashed client address.
    if (req.user) {
      res.json(await campaignQuizzesService.rate(slug, req.user.id, rating));
      return;
    }

    res.json(
      await campaignQuizzesService.rateAsGuest(
        slug,
        resolveTrustedClientIp(req),
        rating,
      ),
    );
  },
};
