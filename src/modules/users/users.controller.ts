import type { Request, Response } from 'express';
import { usersService } from './users.service.js';
import { achievementsService } from '../achievements/index.js';
import { toAchievementsResponse, toUserResponse, toPublicProfileResponse, type UpdateProfileRequest, type UserIdParam, type UserSearchQuery } from './users.schemas.js';

/**
 * Users controller.
 * Translates HTTP ↔ Service calls. NO business logic.
 * Controllers read ONLY req.validated.* (never req.body directly).
 */
export const usersController = {
  /**
   * GET /api/v1/users/me
   * Get current user profile.
   */
  async getMe(req: Request, res: Response): Promise<void> {
    // Reload from the database so response fields like progression are not stale
    // when req.user came from the auth middleware cache earlier in the request lifecycle.
    const user = await usersService.getById(req.user!.id);
    res.json(toUserResponse(user));
  },

  /**
   * PUT /api/v1/users/me
   * Update current user profile.
   */
  async updateMe(req: Request, res: Response): Promise<void> {
    const userId = req.user!.id;
    const data = req.validated.body as UpdateProfileRequest;

    const updatedUser = await usersService.updateProfile(userId, {
      nickname: data.nickname,
      country: data.country,
      avatarUrl: data.avatar_url,
      avatarCustomization: data.avatar_customization,
      favoriteClub: data.favorite_club,
      preferredLanguage: data.preferred_language,
    }, {
      requesterRole: req.user!.role,
    });

    res.json(toUserResponse(updatedUser));
  },

  /**
   * GET /api/v1/users/:userId/profile
   * Get public profile for a user.
   */
  async getPublicProfile(req: Request, res: Response): Promise<void> {
    const { userId } = req.validated.params as UserIdParam;
    const profile = await usersService.getPublicProfile(userId, req.user!.id);
    res.json(toPublicProfileResponse(profile));
  },

  async getMyAchievements(req: Request, res: Response): Promise<void> {
    const achievements = await achievementsService.listForUser(req.user!.id);
    res.json(toAchievementsResponse(achievements));
  },

  async getUserAchievements(req: Request, res: Response): Promise<void> {
    const { userId } = req.validated.params as UserIdParam;
    const achievements = await achievementsService.listForUser(userId);
    res.json(toAchievementsResponse(achievements));
  },

  /**
   * GET /api/v1/users/search?q=
   * Search users by nickname.
   */
  async searchUsers(req: Request, res: Response): Promise<void> {
    const { q } = req.validated.query as UserSearchQuery;
    const requesterId = req.user!.id;
    const results = await usersService.searchByNickname(q, requesterId);
    res.json({ results });
  },

  /**
   * POST /api/v1/users/me/complete-onboarding
   * Mark onboarding as complete.
   */
  async completeOnboarding(req: Request, res: Response): Promise<void> {
    const userId = req.user!.id;

    const updatedUser = await usersService.completeOnboarding(userId);

    res.json(toUserResponse(updatedUser));
  },
};
