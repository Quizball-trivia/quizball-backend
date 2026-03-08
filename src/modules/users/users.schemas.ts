import { z } from 'zod';
import type { UserStatsSummary, HeadToHeadSummary } from '../stats/stats.service.js';
import type { RankedUserRankResult } from '../ranked/ranked.types.js';

/**
 * userId path parameter schema.
 */
export const userIdParamSchema = z.object({
  userId: z.string().uuid(),
});

export type UserIdParam = z.infer<typeof userIdParamSchema>;

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

/**
 * Public profile response — excludes private fields (email, preferred_language, onboarding_complete).
 */
export interface PublicProfileData {
  user: {
    id: string;
    nickname: string | null;
    avatar_url: string | null;
    country: string | null;
    favorite_club: string | null;
  };
  ranked: {
    rp: number;
    tier: string;
    placementStatus: string;
    placementPlayed: number;
    placementRequired: number;
    placementWins: number;
    currentWinStreak: number;
    lastRankedMatchAt: string | null;
  } | null;
  stats: UserStatsSummary;
  headToHead: HeadToHeadSummary | null;
  globalRank: Pick<RankedUserRankResult, 'rank' | 'total'> | null;
  countryRank: Pick<RankedUserRankResult, 'rank' | 'total'> | null;
}

export const achievementResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  icon: z.string(),
  unlocked: z.boolean(),
  progress: z.number().int().nonnegative(),
  target: z.number().int().positive(),
  unlockedAt: z.string().datetime().nullable(),
});

export const achievementsResponseSchema = z.object({
  achievements: z.array(achievementResponseSchema),
});

export type AchievementResponse = z.infer<typeof achievementResponseSchema>;
export type AchievementsResponse = z.infer<typeof achievementsResponseSchema>;

export function toPublicProfileResponse(data: PublicProfileData) {
  return {
    id: data.user.id,
    nickname: data.user.nickname,
    avatarUrl: data.user.avatar_url,
    country: data.user.country,
    favoriteClub: data.user.favorite_club,
    ranked: data.ranked,
    stats: data.stats,
    headToHead: data.headToHead,
    globalRank: data.globalRank,
    countryRank: data.countryRank,
  };
}

export function toAchievementsResponse(data: AchievementResponse[]) {
  return {
    achievements: data,
  };
}
