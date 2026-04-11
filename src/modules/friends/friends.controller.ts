import type { Request, Response } from 'express';
import { friendsService } from './friends.service.js';
import type {
  CreateFriendRequestBody,
  FriendRequestIdParam,
  FriendUserIdParam,
} from './friends.schemas.js';

export const friendsController = {
  async listFriends(req: Request, res: Response): Promise<void> {
    const result = await friendsService.listFriends(req.user!.id);
    res.json(result);
  },

  async listRequests(req: Request, res: Response): Promise<void> {
    const result = await friendsService.listRequests(req.user!.id);
    res.json(result);
  },

  async createRequest(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as CreateFriendRequestBody;
    const result = await friendsService.createRequest(req.user!.id, body.targetUserId);
    res.status(201).json(result);
  },

  async acceptRequest(req: Request, res: Response): Promise<void> {
    const { requestId } = req.validated.params as FriendRequestIdParam;
    const result = await friendsService.acceptRequest(req.user!.id, requestId);
    res.json(result);
  },

  async declineRequest(req: Request, res: Response): Promise<void> {
    const { requestId } = req.validated.params as FriendRequestIdParam;
    const result = await friendsService.declineRequest(req.user!.id, requestId);
    res.json(result);
  },

  async cancelRequest(req: Request, res: Response): Promise<void> {
    const { requestId } = req.validated.params as FriendRequestIdParam;
    const result = await friendsService.cancelRequest(req.user!.id, requestId);
    res.json(result);
  },

  async removeFriend(req: Request, res: Response): Promise<void> {
    const { friendUserId } = req.validated.params as FriendUserIdParam;
    const result = await friendsService.removeFriend(req.user!.id, friendUserId);
    res.json(result);
  },
};
