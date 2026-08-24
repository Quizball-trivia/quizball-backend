import type { Request, Response } from 'express';
import { playerClueCardsService } from './player-clue-cards.service.js';
import { playerClueCardsRepo } from './player-clue-cards.repo.js';
import type {
  BulkUpdateStatusRequest,
  ImportCommitRequest,
  ImportPreviewRequest,
  UpdateStatusRequest,
} from './player-clue-cards.schemas.js';
import type { ClueCardIdParam } from './player-clue-cards.schemas.js';

export const playerClueCardsController = {
  async previewImport(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as ImportPreviewRequest;
    const result = await playerClueCardsService.previewImport(body);
    res.json(result);
  },

  async commitImport(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as ImportCommitRequest;
    const adminUserId = req.user?.id;
    if (!adminUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const result = await playerClueCardsService.commitImport(body, adminUserId);
    res.json(result);
  },

  async updateStatus(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as ClueCardIdParam;
    const body = req.validated.body as UpdateStatusRequest;
    const adminUserId = req.user?.id;
    if (!adminUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    await playerClueCardsService.updateStatus(id, body, adminUserId);
    const updated = await playerClueCardsRepo.getPlayerClueCardById(id);
    res.json(updated);
  },

  async bulkUpdateStatus(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as BulkUpdateStatusRequest;
    const adminUserId = req.user?.id;
    if (!adminUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const result = await playerClueCardsService.bulkUpdateStatus(body, adminUserId);
    res.json(result);
  },

  async translateStatus(_req: Request, res: Response): Promise<void> {
    const result = await playerClueCardsService.getTranslateStatus();
    res.json(result);
  },

  async translateBackfill(req: Request, res: Response): Promise<void> {
    const adminUserId = req.user?.id;
    if (!adminUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const result = await playerClueCardsService.translateMissingKaSiblings(adminUserId);
    res.json(result);
  },
};
