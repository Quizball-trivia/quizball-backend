import { z } from 'zod';

/**
 * User response schema.
 */
export const userResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().nullable(),
  nickname: z.string().nullable(),
  country: z.string().nullable(),
  avatar_url: z.string().url().nullable(),
  favorite_club: z.string().nullable(),
  preferred_language: z.string().nullable(),
  onboarding_complete: z.boolean(),
  created_at: z.string().datetime(),
});

export type UserResponse = z.infer<typeof userResponseSchema>;

/**
 * Update profile request schema.
 */
export const updateProfileSchema = z.object({
  nickname: z.string().min(1).max(50).optional(),
  country: z.string().min(2).max(100).optional(),
  avatar_url: z.string().url().optional(),
  favorite_club: z.string().min(1).max(100).optional(),
  preferred_language: z.string().min(2).max(10).optional(),
});

export type UpdateProfileRequest = z.infer<typeof updateProfileSchema>;

/**
 * Convert database User to API response format.
 */
export function toUserResponse(user: {
  id: string;
  email: string | null;
  nickname: string | null;
  country: string | null;
  avatar_url: string | null;
  favorite_club: string | null;
  preferred_language: string | null;
  onboarding_complete: boolean;
  created_at: string;
}): UserResponse {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    country: user.country,
    avatar_url: user.avatar_url,
    favorite_club: user.favorite_club,
    preferred_language: user.preferred_language,
    onboarding_complete: user.onboarding_complete,
    created_at: user.created_at,
  };
}
