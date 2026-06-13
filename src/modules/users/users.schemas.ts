import { z } from 'zod';
import type { UserStatsSummary, HeadToHeadSummary } from '../stats/stats.service.js';
import type { RankedUserRankResult } from '../ranked/ranked.types.js';
import type { PlacementStatus, RankedTier } from '../ranked/ranked.types.js';
import { headToHeadResponseSchema, statsSummaryResponseSchema } from '../stats/stats.schemas.js';
import { progressionResponseSchema, type ProgressionResponse } from '../progression/progression.schemas.js';
import { getProgressionFromTotalXp } from '../progression/progression.logic.js';
import { rankedProfileResponseSchema } from '../ranked/ranked.schemas.js';
import { friendStatusSchema } from '../friends/friends.schemas.js';
import { avatarCustomizationSchema, parseStoredAvatarCustomization } from './avatar-customization.js';
import { i18nFieldSchema } from '../../http/schemas/shared.js';

export const userRoleSchema = z.enum(['admin', 'user']);
export type UserRole = z.infer<typeof userRoleSchema>;

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
  phone_number: z.string().nullable(),
  phone_verified_at: z.string().datetime().nullable(),
  role: userRoleSchema,
  nickname: z.string().nullable(),
  country: z.string().nullable(),
  avatar_url: z.string().url().nullable(),
  avatar_customization: avatarCustomizationSchema.nullable(),
  favorite_club: z.string().nullable(),
  preferred_language: z.string().nullable(),
  onboarding_complete: z.boolean(),
  progression: progressionResponseSchema,
  created_at: z.string().datetime(),
});

export type UserResponse = z.infer<typeof userResponseSchema>;

export const accountDeletionResponseSchema = z.object({
  deletionRequestedAt: z.string().datetime(),
  pendingDeletionAt: z.string().datetime(),
});

export type AccountDeletionResponse = z.infer<typeof accountDeletionResponseSchema>;

/**
 * Update profile request schema.
 */
export const updateProfileSchema = z.object({
  nickname: z.string().min(1).max(50).optional(),
  country: z.string().min(2).max(100).optional(),
  avatar_url: z.string().url().nullable().optional(),
  avatar_customization: avatarCustomizationSchema.nullable().optional(),
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
  phone_number?: string | null;
  phone_verified_at?: string | null;
  role: string;
  nickname: string | null;
  country: string | null;
  avatar_url: string | null;
  avatar_customization?: unknown;
  favorite_club: string | null;
  preferred_language: string | null;
  onboarding_complete: boolean;
  total_xp: number;
  created_at: string;
}): UserResponse {
  return {
    id: user.id,
    email: user.email,
    phone_number: user.phone_number ?? null,
    phone_verified_at: user.phone_verified_at ?? null,
    role: user.role as UserRole,
    nickname: user.nickname,
    country: user.country,
    avatar_url: user.avatar_url,
    avatar_customization: parseStoredAvatarCustomization(user.avatar_customization),
    favorite_club: user.favorite_club,
    preferred_language: user.preferred_language,
    onboarding_complete: user.onboarding_complete,
    progression: getProgressionFromTotalXp(user.total_xp),
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
    avatar_customization?: unknown;
    country: string | null;
    favorite_club: string | null;
    total_xp: number;
  };
  progression: ProgressionResponse;
  ranked: {
    rp: number;
    tier: RankedTier;
    placementStatus: PlacementStatus;
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

const rankPositionSchema = z.object({
  rank: z.number().int(),
  total: z.number().int(),
});

export const publicProfileResponseSchema = z.object({
  id: z.string().uuid(),
  nickname: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  avatarCustomization: avatarCustomizationSchema.nullable(),
  country: z.string().nullable(),
  favoriteClub: z.string().nullable(),
  progression: progressionResponseSchema,
  ranked: rankedProfileResponseSchema.nullable(),
  stats: statsSummaryResponseSchema,
  headToHead: headToHeadResponseSchema.nullable(),
  globalRank: rankPositionSchema.nullable(),
  countryRank: rankPositionSchema.nullable(),
});

export type PublicProfileResponse = z.infer<typeof publicProfileResponseSchema>;

export const achievementResponseSchema = z.object({
  id: z.string(),
  title: i18nFieldSchema,
  description: i18nFieldSchema,
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
    avatarCustomization: parseStoredAvatarCustomization(data.user.avatar_customization),
    country: data.user.country,
    favoriteClub: data.user.favorite_club,
    progression: data.progression,
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

export function toAccountDeletionResponse(data: {
  deletionRequestedAt: string;
  pendingDeletionAt: string;
}): AccountDeletionResponse {
  return {
    deletionRequestedAt: data.deletionRequestedAt,
    pendingDeletionAt: data.pendingDeletionAt,
  };
}

/**
 * User search query schema.
 */
export const userSearchQuerySchema = z.object({
  q: z.string().min(1).max(50),
});

export type UserSearchQuery = z.infer<typeof userSearchQuerySchema>;

/**
 * User search result item schema.
 */
export const userSearchResultSchema = z.object({
  id: z.string().uuid(),
  nickname: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  avatarCustomization: avatarCustomizationSchema.nullable(),
  level: z.number().int().positive(),
  // Search filters out deleted/pending users so this is always false here, but the
  // field stays in the shape so frontend types stay consistent across endpoints.
  pendingDeletion: z.boolean(),
  ranked: rankedProfileResponseSchema.nullable(),
  friendStatus: friendStatusSchema,
});

export const userSearchResponseSchema = z.object({
  results: z.array(userSearchResultSchema),
});

export type UserSearchResult = z.infer<typeof userSearchResultSchema>;
export type UserSearchResponse = z.infer<typeof userSearchResponseSchema>;

/**
 * Admin: list-all-users query.
 * Paginated + searchable by nickname/email. orderBy is whitelisted to columns
 * the repo knows how to sort by safely.
 */
export const adminUsersListQuerySchema = z.object({
  search: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  orderBy: z
    .enum(['created_at', 'total_xp', 'rp', 'nickname'])
    .optional()
    .default('created_at'),
  orderDir: z.enum(['asc', 'desc']).optional().default('desc'),
});

export type AdminUsersListQuery = z.infer<typeof adminUsersListQuerySchema>;

/**
 * Admin: a single user row in the admin list, flattened with ranked + wallet data.
 */
export const adminUserListItemSchema = z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  nickname: z.string().nullable(),
  country: z.string().nullable(),
  avatar_url: z.string().url().nullable(),
  total_xp: z.number().int().nonnegative(),
  level: z.number().int().positive(),
  rp: z.number().int().nullable(),
  tier: z.string().nullable(),
  placement_status: z.enum(['unplaced', 'in_progress', 'placed']).nullable(),
  coins: z.number().int().nonnegative(),
  tickets: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
});

export type AdminUserListItem = z.infer<typeof adminUserListItemSchema>;

export const adminUsersListResponseSchema = z.object({
  items: z.array(adminUserListItemSchema),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

export type AdminUsersListResponse = z.infer<typeof adminUsersListResponseSchema>;

/**
 * Admin: set/grant progression (XP and/or RP).
 * Each field is optional; mode 'set' assigns an absolute value, 'delta' adds
 * (or subtracts) from the current value. At least one of xp/rp must be present.
 * Final values are clamped to >= 0 by the service.
 */
const progressionAdjustmentSchema = z.object({
  mode: z.enum(['set', 'delta']),
  value: z.number().int(),
});

// NOTE: do NOT chain `.openapi()` here. This module is imported at app boot
// BEFORE the zod-openapi extension is applied, so `.openapi()` is undefined at
// runtime and crashes the server on startup (healthcheck fails → rollback).
// The "at least one of xp/rp" rule is enforced by the `.refine()` below; the
// OpenAPI doc note lives in the endpoint registration (users.openapi.ts).
export const adminSetProgressionBodySchema = z
  .object({
    xp: progressionAdjustmentSchema.optional(),
    rp: progressionAdjustmentSchema.optional(),
    reason: z.string().min(3).max(200),
    // When true (default), send the user an in-app notification about the change.
    notify: z.boolean().optional().default(true),
  })
  .refine((body) => body.xp !== undefined || body.rp !== undefined, {
    message: 'At least one of xp or rp must be provided',
  });

export type AdminSetProgressionBody = z.infer<typeof adminSetProgressionBodySchema>;

/**
 * Admin: response after a progression adjustment — the new absolute values plus
 * recomputed level/tier so the client can refresh its row without a re-fetch.
 */
export const adminProgressionResultSchema = z.object({
  userId: z.string().uuid(),
  total_xp: z.number().int().nonnegative(),
  level: z.number().int().positive(),
  rp: z.number().int().nullable(),
  tier: z.string().nullable(),
});

export type AdminProgressionResult = z.infer<typeof adminProgressionResultSchema>;
