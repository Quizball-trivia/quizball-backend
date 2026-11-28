import type { Request, Response } from 'express';
import { gamesHub } from './harness.games.js';
import { harnessService } from './harness.service.js';
import type {
  ApplyAskBody,
  CreateGameChangeBody,
  CreateIdeaBody,
  RefuseIdeaBody,
  ScoutIdeasBody,
  CreateReportBody,
  ReplanGameChangeBody,
  ApproveShowPackBody,
  BriefParam,
  CreateAskBody,
  CreateEventBody,
  CreateProposalBody,
  IdParam,
  CategoryParam,
  CreateRequestBody,
  ItemActionBody,
  ItemParam,
  PolicyKeyParam,
  SetDirectionBody,
  MergeGameChangeBody,
  SetPolicyBody,
  SetSteeringBody,
  SwapShowQuestionBody,
  UpdateHarnessSettingsBody,
} from './harness.schemas.js';

const userId = (req: Request) => req.user?.id ?? null;

export const harnessController = {
  /** The Games hub: every game, its state, its plays and where to play a preview. Read-only. */
  async games(_req: Request, res: Response): Promise<void> {
    res.json(await gamesHub.overview());
  },
  async gameChanges(_req: Request, res: Response): Promise<void> {
    res.json({ items: await harnessService.gameChanges(), building: { connected: harnessService.buildingConnected() } });
  },
  async createGameChange(req: Request, res: Response): Promise<void> {
    res.status(201).json(await harnessService.createGameChange(req.validated.body as CreateGameChangeBody, userId(req)));
  },
  async replanGameChange(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.replanGameChange((req.validated.params as IdParam).id, (req.validated.body as ReplanGameChangeBody).request, userId(req)));
  },
  async cancelGameChange(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.cancelGameChange((req.validated.params as IdParam).id, userId(req)));
  },

  /** Reports written by the desk agents (Growth Analyst, Investor Scout, ...). */
  async reports(_req: Request, res: Response): Promise<void> {
    res.json(await harnessService.reports());
  },
  async createReport(req: Request, res: Response): Promise<void> {
    res.status(201).json(await harnessService.createReport((req.validated.body as CreateReportBody).agent, userId(req)));
  },
  async archiveReport(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.archiveReport((req.validated.params as IdParam).id, userId(req)));
  },
  /** The Day Builder: days ahead and rounds on their way, per daily game. */
  async days(_req: Request, res: Response): Promise<void> {
    res.json(await harnessService.days());
  },
  async dayRounds(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.dayRounds((req.validated.params as { game: string }).game));
  },
  async buildDays(req: Request, res: Response): Promise<void> {
    res.status(202).json(await harnessService.buildDays((req.validated.params as { game: string }).game, userId(req)));
  },
  /** What players wrote to us, with the Feedback Reader's recap. */
  async feedback(_req: Request, res: Response): Promise<void> {
    res.json(await harnessService.feedback());
  },
  async readFeedback(req: Request, res: Response): Promise<void> {
    res.status(202).json(await harnessService.readFeedback(userId(req)));
  },
  async importFeedbackEmails(req: Request, res: Response): Promise<void> {
    res.status(202).json(await harnessService.importFeedbackEmails(userId(req)));
  },
  async createIdea(req: Request, res: Response): Promise<void> {
    res.status(201).json(await harnessService.createIdea(req.validated.body as CreateIdeaBody, userId(req)));
  },
  async scoutIdeas(req: Request, res: Response): Promise<void> {
    res.status(202).json(await harnessService.scoutIdeas((req.validated.body as ScoutIdeasBody).market, userId(req)));
  },
  async acceptIdea(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.acceptIdea((req.validated.params as IdParam).id, userId(req)));
  },
  async refuseIdea(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.refuseIdea((req.validated.params as IdParam).id, (req.validated.body as RefuseIdeaBody).reason, userId(req)));
  },
  async buildGameChange(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.buildGameChange((req.validated.params as IdParam).id, userId(req)));
  },
  async mergeGameChange(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.mergeGameChange((req.validated.params as IdParam).id, (req.validated.body as MergeGameChangeBody).seen, userId(req)));
  },
  async discardGameChange(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.discardGameChange((req.validated.params as IdParam).id, userId(req)));
  },
  async overview(_req: Request, res: Response): Promise<void> {
    res.json(await harnessService.overview());
  },
  async updateSettings(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.updateSettings(req.validated.body as UpdateHarnessSettingsBody, userId(req)));
  },
  async setPolicy(req: Request, res: Response): Promise<void> {
    const { key } = req.validated.params as PolicyKeyParam;
    res.json(await harnessService.setPolicy(key, (req.validated.body as SetPolicyBody).value, userId(req)));
  },
  async setSteering(req: Request, res: Response): Promise<void> {
    const { categoryId } = req.validated.params as CategoryParam;
    res.json(await harnessService.setSteering(categoryId, req.validated.body as SetSteeringBody, userId(req)));
  },
  async setDirection(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.setDirection((req.validated.body as SetDirectionBody).direction, userId(req)));
  },
  async createRequest(req: Request, res: Response): Promise<void> {
    res.status(201).json(await harnessService.createRequest(req.validated.body as CreateRequestBody, userId(req)));
  },
  async cancelRequest(req: Request, res: Response): Promise<void> {
    const { briefId } = req.validated.params as BriefParam;
    res.json(await harnessService.cancelRequest(briefId, userId(req)));
  },
  async itemAction(req: Request, res: Response): Promise<void> {
    const { itemId } = req.validated.params as ItemParam;
    res.json(await harnessService.itemAction(itemId, req.validated.body as ItemActionBody, userId(req)));
  },
  async createEvent(req: Request, res: Response): Promise<void> {
    res.status(201).json(await harnessService.createEvent(req.validated.body as CreateEventBody, userId(req)));
  },
  async cancelEvent(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.cancelEvent((req.validated.params as IdParam).id, userId(req)));
  },
  async createProposal(req: Request, res: Response): Promise<void> {
    res.status(201).json(await harnessService.createProposal(req.validated.body as CreateProposalBody, userId(req)));
  },
  async proposalGoLive(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.proposalGoLive((req.validated.params as IdParam).id, userId(req)));
  },
  async cancelProposal(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.cancelProposal((req.validated.params as IdParam).id, userId(req)));
  },
  async createAsk(req: Request, res: Response): Promise<void> {
    res.status(201).json(await harnessService.createAsk((req.validated.body as CreateAskBody).message, userId(req)));
  },
  async applyAsk(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.applyAsk((req.validated.params as IdParam).id, (req.validated.body as ApplyAskBody).indexes, userId(req)));
  },
  async swapShowQuestion(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.swapShowQuestion((req.validated.params as IdParam).id, req.validated.body as SwapShowQuestionBody, userId(req)));
  },
  async newShowPack(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.newShowPack((req.validated.params as IdParam).id, userId(req)));
  },
  async approveShowPack(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.approveShowPack((req.validated.params as IdParam).id, (req.validated.body as ApproveShowPackBody).seen, userId(req)));
  },
  async dismissAsk(req: Request, res: Response): Promise<void> {
    res.json(await harnessService.dismissAsk((req.validated.params as IdParam).id, userId(req)));
  },
};
