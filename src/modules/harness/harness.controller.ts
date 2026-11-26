import type { Request, Response } from 'express';
import { harnessService } from './harness.service.js';
import type { PolicyKeyParam, SetPolicyBody, UpdateHarnessSettingsBody } from './harness.schemas.js';

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
};
