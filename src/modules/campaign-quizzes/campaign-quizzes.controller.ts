import type { Request, Response } from 'express';
import { resolveTrustedClientIp } from '../../http/client-ip.js';
import type {
  CampaignQuizAnswerBody,
  CampaignQuizLocaleQuery,
  CampaignQuizListQuery,
  CampaignQuizPreviewQuery,
  CampaignQuizRatingBody,
  CampaignQuizSlugParams,
  CampaignQuizRouteQuery,
} from './campaign-quizzes.schemas.js';
import { campaignQuizzesService } from './campaign-quizzes.service.js';

export const campaignQuizzesController = {
  async list(req: Request, res: Response): Promise<void> {
    const { locale } = req.validated.query as CampaignQuizListQuery;
    res.json(await campaignQuizzesService.listPublished(locale));
  },

  async resolveRoute(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    const { locale, public: publicSlug } = req.validated.query as CampaignQuizRouteQuery;
    res.json(await campaignQuizzesService.resolveRoute(slug, locale, publicSlug));
  },

  async getQuiz(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    const { preview, locale } = req.validated.query as CampaignQuizPreviewQuery;
    res.json(await campaignQuizzesService.getQuiz(slug, preview, locale));
  },

  async answer(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    const body = req.validated.body as CampaignQuizAnswerBody;
    const { locale } = req.validated.query as CampaignQuizLocaleQuery;
    res.json(
      await campaignQuizzesService.answer(
        slug,
        body.question_id,
        body.selected_option_id,
        body.preview_token,
        locale,
        body.set_version,
      ),
    );
  },

  async listSlugs(_req: Request, res: Response): Promise<void> {
    res.json(await campaignQuizzesService.listSlugs());
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
