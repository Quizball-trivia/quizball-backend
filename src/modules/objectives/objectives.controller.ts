import type { Request, Response } from 'express';
import { objectivesService } from './objectives.service.js';
import { AuthenticationError } from '../../core/errors.js';

export const objectivesController = {
  async list(req: Request, res: Response): Promise<void> {
    if (!req.user) {
      throw new AuthenticationError();
    }
    const result = await objectivesService.listForUser(req.user.id);
    res.json(result);
  },
};
