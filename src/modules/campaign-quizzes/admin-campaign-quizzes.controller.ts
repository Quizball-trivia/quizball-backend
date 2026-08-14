import type { Request, Response } from 'express';
import type {
  AdminCampaignQuizImageBody,
  AdminCampaignQuizImageGenerateBody,
  AdminCampaignQuizHubOrderBody,
  AdminCampaignQuizListQuery,
  AdminCampaignQuizPageBody,
  AdminCampaignQuizPublishBody,
  AdminCampaignQuizRetireBody,
  CampaignQuizSlugParams,
  AdminCampaignQuizRevisionParams,
} from './campaign-quizzes.schemas.js';
import { campaignQuizzesService } from './campaign-quizzes.service.js';

function adminUserId(req: Request): string {
  return req.user!.id;
}

export const adminCampaignQuizzesController = {
  async list(req: Request, res: Response): Promise<void> {
    res.json(
      await campaignQuizzesService.listAdmin(
        req.validated.query as AdminCampaignQuizListQuery,
      ),
    );
  },

  async listQuestionSets(_req: Request, res: Response): Promise<void> {
    res.json(await campaignQuizzesService.listQuestionSets());
  },

  async updateHubOrder(req: Request, res: Response): Promise<void> {
    await campaignQuizzesService.updateHubOrder(
      req.validated.body as AdminCampaignQuizHubOrderBody,
      adminUserId(req),
    );
    res.status(204).send();
  },

  async searchConsole(_req: Request, res: Response): Promise<void> {
    res.json(await campaignQuizzesService.searchConsoleMetrics());
  },

  async get(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    res.json(await campaignQuizzesService.getAdmin(slug));
  },

  async create(req: Request, res: Response): Promise<void> {
    const page = await campaignQuizzesService.createAdmin(
      req.validated.body as AdminCampaignQuizPageBody,
      adminUserId(req),
    );
    res.status(201).json(page);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    res.json(
      await campaignQuizzesService.updateAdmin(
        slug,
        req.validated.body as AdminCampaignQuizPageBody,
        adminUserId(req),
      ),
    );
  },

  async preview(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    res.json(await campaignQuizzesService.preview(slug, adminUserId(req)));
  },

  async googlebot(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    res.json(await campaignQuizzesService.inspectAsGooglebot(slug));
  },

  async listRevisions(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    res.json(await campaignQuizzesService.listRevisions(slug));
  },

  async restoreRevision(req: Request, res: Response): Promise<void> {
    const { slug, revisionId } = req.validated.params as AdminCampaignQuizRevisionParams;
    res.json(await campaignQuizzesService.restoreRevision(slug, revisionId, adminUserId(req)));
  },

  async publish(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    res.json(
      await campaignQuizzesService.publish(
        slug,
        req.validated.body as AdminCampaignQuizPublishBody,
        adminUserId(req),
      ),
    );
  },

  async unpublish(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    await campaignQuizzesService.retire(
      slug,
      req.validated.body as AdminCampaignQuizRetireBody,
      adminUserId(req),
      false,
    );
    res.status(204).send();
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    await campaignQuizzesService.retire(
      slug,
      req.validated.body as AdminCampaignQuizRetireBody,
      adminUserId(req),
      true,
    );
    res.status(204).send();
  },

  async uploadImage(req: Request, res: Response): Promise<void> {
    res.status(201).json(
      await campaignQuizzesService.uploadImage(
        req.validated.body as AdminCampaignQuizImageBody,
      ),
    );
  },

  async generateImage(req: Request, res: Response): Promise<void> {
    res.json(
      await campaignQuizzesService.generateImage(
        req.validated.body as AdminCampaignQuizImageGenerateBody,
      ),
    );
  },
};
