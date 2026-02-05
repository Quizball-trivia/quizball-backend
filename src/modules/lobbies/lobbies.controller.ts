import type { Request, Response } from 'express';
import { lobbiesService } from './lobbies.service.js';
import type { ListPublicLobbiesQuery } from './lobbies.schemas.js';

/**
 * Lobbies controller.
 * Translates HTTP <-> Service calls. NO business logic.
 * Controllers read ONLY req.validated.* (never req.body directly).
 */
export const lobbiesController = {
  /**
   * GET /api/v1/lobbies/public
   * List public lobbies.
   */
  async listPublic(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as ListPublicLobbiesQuery;

    const items = await lobbiesService.listPublicLobbies({
      limit: query.limit,
      joinableOnly: query.joinableOnly,
    });

    res.json({ items });
  },
};
