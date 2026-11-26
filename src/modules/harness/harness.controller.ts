import type { Request, Response } from 'express';
import { harnessService } from './harness.service.js';
import type {
  BriefParam,
  CategoryParam,
  CreateRequestBody,
  ItemActionBody,
  ItemParam,
  PolicyKeyParam,
  SetDirectionBody,
  SetPolicyBody,
  SetSteeringBody,
  UpdateHarnessSettingsBody,
} from './harness.schemas.js';

const userId = (req: Request) => req.user?.id ?? null;

export const harnessController = {
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
};
