import type { Request, Response } from 'express';
import { usersService } from './users.service.js';
import { toUserResponse, type UpdateProfileRequest } from './users.schemas.js';

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
    // req.user is set by auth middleware
    const user = req.user!;
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
      favoriteClub: data.favorite_club,
      preferredLanguage: data.preferred_language,
    });

    res.json(toUserResponse(updatedUser));
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
