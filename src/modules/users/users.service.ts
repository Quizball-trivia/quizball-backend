import type { User } from '../../db/types.js';
import { usersRepo, type UpdateUserData } from './users.repo.js';
import { identitiesRepo } from './identities.repo.js';
import { NotFoundError } from '../../core/errors.js';
import type { AuthIdentity } from '../../core/types.js';
import { logger } from '../../core/logger.js';
import { getCachedUser, setCachedUser, updateCachedUser } from './user-cache.js';
import { rankedRepo } from '../ranked/ranked.repo.js';
import { statsService } from '../stats/stats.service.js';
import type { PublicProfileData } from './users.schemas.js';
import { progressionService } from '../progression/progression.service.js';

/**
 * Users service.
 * Contains ALL business logic for user operations.
 * NO Express types (req/res). NO direct Prisma calls.
 */
export const usersService = {
  /**
   * Get or create user from auth identity.
   * This is the main entry point after JWT verification.
   *
   * Flow:
   * 1. Check cache for user
   * 2. Look up UserIdentity by (provider, subject)
   * 3. If exists → cache and return associated User
   * 4. If not → create User + UserIdentity atomically, cache and return User
   */
  async getOrCreateFromIdentity(identity: AuthIdentity, detectedCountry?: string | null): Promise<User> {
    // 1. Check cache first
    const cached = getCachedUser(identity.provider, identity.subject);
    if (cached) {
      // Backfill missing fields for existing users
      const backfill: Record<string, string> = {};
      if (!cached.country && detectedCountry) backfill.country = detectedCountry;
      if (!cached.avatar_url && identity.avatarUrl) backfill.avatarUrl = identity.avatarUrl;

      if (Object.keys(backfill).length > 0) {
        const updated = await usersRepo.update(cached.id, backfill);
        if (updated) {
          updateCachedUser(cached.id, updated);
          logger.info({ userId: cached.id, ...backfill }, 'Backfilled user fields');
          return updated;
        }
      }
      return cached;
    }

    // 2. Look up existing identity
    const existingIdentity = await identitiesRepo.getByProviderSubject(
      identity.provider,
      identity.subject
    );

    if (existingIdentity) {
      const existingUser = existingIdentity.user;

      // Backfill missing fields for existing users
      const backfill: Record<string, string> = {};
      if (!existingUser.country && detectedCountry) backfill.country = detectedCountry;
      if (!existingUser.avatar_url && identity.avatarUrl) backfill.avatarUrl = identity.avatarUrl;

      if (Object.keys(backfill).length > 0) {
        const updated = await usersRepo.update(existingUser.id, backfill);
        if (updated) {
          setCachedUser(identity.provider, identity.subject, updated);
          logger.info({ userId: existingUser.id, ...backfill }, 'Backfilled user fields');
          return updated;
        }
      }

      setCachedUser(identity.provider, identity.subject, existingUser);
      return existingUser;
    }

    // 3. Create new user with identity in a single transaction
    logger.info(
      { provider: identity.provider, subject: identity.subject },
      'Creating new user for identity'
    );

    const newUser = await usersRepo.createWithIdentity(
      {
        email: identity.email,
        nickname: identity.name,
        avatarUrl: identity.avatarUrl,
        country: detectedCountry ?? undefined,
      },
      {
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email,
      }
    );

    logger.info(
      { userId: newUser.id, provider: identity.provider, country: detectedCountry },
      'Created new user and identity'
    );

    setCachedUser(identity.provider, identity.subject, newUser);
    return newUser;
  },

  /**
   * Get user by ID.
   * Throws NotFoundError if user doesn't exist.
   */
  async getById(id: string): Promise<User> {
    const user = await usersRepo.getById(id);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    return user;
  },

  /**
   * Update user profile.
   * Only allows updating: nickname, country, avatarUrl, favoriteClub, preferredLanguage
   */
  async updateProfile(
    id: string,
    data: Pick<UpdateUserData, 'nickname' | 'country' | 'avatarUrl' | 'favoriteClub' | 'preferredLanguage'>
  ): Promise<User> {
    const user = await usersRepo.update(id, data);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Update cache with new user data
    updateCachedUser(id, user);

    logger.debug({ userId: id }, 'Updated user profile');
    return user;
  },

  /**
   * Get public profile for a target user, including ranked, stats, and H2H with the viewer.
   */
  async getPublicProfile(targetUserId: string, viewerUserId: string): Promise<PublicProfileData> {
    const user = await usersRepo.getById(targetUserId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const [rankedProfile, statsSummary, headToHead, globalRank, countryRank] = await Promise.all([
      rankedRepo.getProfile(targetUserId),
      statsService.getUserStatsSummary(targetUserId),
      viewerUserId !== targetUserId
        ? statsService.getHeadToHead(viewerUserId, targetUserId)
        : Promise.resolve(null),
      rankedRepo.getUserRank(targetUserId),
      user.country ? rankedRepo.getUserRank(targetUserId, user.country) : Promise.resolve(null),
    ]);

    return {
      user: {
        id: user.id,
        nickname: user.nickname,
        avatar_url: user.avatar_url,
        country: user.country,
        favorite_club: user.favorite_club,
        total_xp: user.total_xp,
      },
      progression: progressionService.getProgression(user.total_xp),
      ranked: rankedProfile ? {
        rp: rankedProfile.rp,
        tier: rankedProfile.tier,
        placementStatus: rankedProfile.placement_status,
        placementPlayed: rankedProfile.placement_played,
        placementRequired: rankedProfile.placement_required,
        placementWins: rankedProfile.placement_wins,
        currentWinStreak: rankedProfile.current_win_streak,
        lastRankedMatchAt: rankedProfile.last_ranked_match_at,
      } : null,
      stats: statsSummary,
      headToHead,
      globalRank: globalRank ? { rank: globalRank.rank, total: globalRank.total } : null,
      countryRank: countryRank ? { rank: countryRank.rank, total: countryRank.total } : null,
    };
  },

  /**
   * Search users by nickname substring. Excludes AI bots, incomplete onboarding, and the requester.
   */
  async searchByNickname(query: string, excludeUserId: string) {
    return usersRepo.searchByNickname(query, excludeUserId);
  },

  /**
   * Mark onboarding as complete.
   */
  async completeOnboarding(id: string): Promise<User> {
    const user = await usersRepo.update(id, { onboardingComplete: true });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Update cache with new user data
    updateCachedUser(id, user);

    logger.info({ userId: id }, 'User completed onboarding');
    return user;
  },
};
