import type { Request, Response } from 'express';
import { campaignAgentUserId } from '../../http/middleware/campaign-agent-auth.js';
import { campaignQuizAgentService } from './campaign-quiz-agent.service.js';
import { campaignQuizzesService } from './campaign-quizzes.service.js';
import type {
  AdminCampaignQuizImageBody,
  AdminCampaignQuizImageGenerateBody,
  AgentCampaignQuizCandidate,
  AgentCampaignQuizCommitBody,
  AgentCampaignQuizDueQuery,
  AgentCampaignQuizLockBody,
  AgentCampaignQuizReviewBody,
  CampaignQuizSlugParams,
} from './campaign-quizzes.schemas.js';

export const campaignQuizAgentController = {
  async due(req: Request, res: Response): Promise<void> {
    const { limit } = req.validated.query as AgentCampaignQuizDueQuery;
    res.json(await campaignQuizAgentService.due(limit));
  },

  async state(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    res.json(await campaignQuizAgentService.state(slug));
  },

  async validate(req: Request, res: Response): Promise<void> {
    res.json(await campaignQuizAgentService.validate(req.validated.body as AgentCampaignQuizCandidate));
  },

  async commit(req: Request, res: Response): Promise<void> {
    res.json(await campaignQuizAgentService.commit(req.validated.body as AgentCampaignQuizCommitBody, campaignAgentUserId()));
  },

  async review(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    res.json(await campaignQuizAgentService.review(slug, req.validated.body as AgentCampaignQuizReviewBody));
  },

  /** The generated image comes back as a data URL; the agent stores it here and commits the returned reference. */
  async uploadImage(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as AdminCampaignQuizImageBody;
    res.status(201).json(await campaignQuizzesService.uploadImage(body));
  },

  async lock(req: Request, res: Response): Promise<void> {
    const { slug } = req.validated.params as CampaignQuizSlugParams;
    const { reason } = req.validated.body as AgentCampaignQuizLockBody;
    res.json(await campaignQuizAgentService.lock(slug, reason, campaignAgentUserId()));
  },

  async generateImage(req: Request, res: Response): Promise<void> {
    res.json(await campaignQuizzesService.generateImage(req.validated.body as AdminCampaignQuizImageGenerateBody));
  },
};
