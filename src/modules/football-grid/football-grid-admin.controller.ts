import type { Request, Response } from 'express';
import { footballGridAdminService } from './football-grid-admin.service.js';

export const footballGridAdminController = {
  async inspectRewards(req: Request, res: Response): Promise<void> {
    const { matchId } = req.validated.params as { matchId: string };
    res.json(await footballGridAdminService.inspectRewards(matchId));
  },
  async releaseHeldCoin(req: Request, res: Response): Promise<void> {
    const { eventId } = req.validated.params as { eventId: string };
    const { reason } = req.validated.body as { reason: string };
    await footballGridAdminService.releaseHeldCoin(eventId, req.user!.id, reason);
    res.status(204).end();
  },
  async reverseCoin(req: Request, res: Response): Promise<void> {
    const { eventId } = req.validated.params as { eventId: string };
    const { reason } = req.validated.body as { reason: string };
    await footballGridAdminService.reverseCoin(eventId, req.user!.id, reason);
    res.status(204).end();
  },
  async releaseHeldPoints(req: Request, res: Response): Promise<void> {
    const { eventId } = req.validated.params as { eventId: string };
    const { reason } = req.validated.body as { reason: string };
    await footballGridAdminService.releaseHeldPoints(eventId, req.user!.id, reason);
    res.status(204).end();
  },
  async reversePoints(req: Request, res: Response): Promise<void> {
    const { eventId } = req.validated.params as { eventId: string };
    const { reason } = req.validated.body as { reason: string };
    await footballGridAdminService.reversePoints(eventId, req.user!.id, reason);
    res.status(204).end();
  },
  async listReports(req: Request, res: Response): Promise<void> {
    const { status, limit } = req.validated.query as { status?: string; limit: number };
    res.json({ reports: await footballGridAdminService.listReports(status, limit) });
  },
  async decideReport(req: Request, res: Response): Promise<void> {
    const { reportId } = req.validated.params as { reportId: string };
    const body = req.validated.body as { status: 'accepted' | 'rejected' | 'duplicate' | 'closed'; notes: string; decisionReleaseId?: string | null };
    await footballGridAdminService.decideReport({ ...body, reportId, actorUserId: req.user!.id });
    res.status(204).end();
  },
  async quarantineContent(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as {
      releaseId: string;
      boardId?: string | null;
      action: 'disable' | 'enable';
      reason: string;
      expiresAt?: string | null;
    };
    const quarantine = await footballGridAdminService.quarantineContent({
      ...body,
      actorUserId: req.user!.id,
    });
    res.status(201).json({ quarantine });
  },
  async listQuarantines(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as { releaseId?: string; boardId?: string; limit: number };
    res.json({ quarantines: await footballGridAdminService.listQuarantines(query) });
  },
  async renamePlayer(req: Request, res: Response): Promise<void> {
    const { playerId } = req.validated.params as { playerId: string };
    const body = req.validated.body as { nameEn?: string; nameKa?: string; reason: string };
    const edit = await footballGridAdminService.renamePlayer({
      playerId,
      ...body,
      actor: `user:${req.user!.id}`,
    });
    res.status(200).json({ edit });
  },
};
