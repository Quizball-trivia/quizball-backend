import type { User } from '../../db/types.js';
import { isUserAccountInactive, usersRepo, type UpdateUserData } from './users.repo.js';
import { identitiesRepo } from './identities.repo.js';
import { AuthenticationError, BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import type { AuthIdentity } from '../../core/types.js';
import { logger } from '../../core/logger.js';
import { getCachedUser, invalidateByUserId, setCachedUser, updateCachedUser } from './user-cache.js';
import { disconnectUserSockets } from '../../realtime/services/auth-realtime.service.js';
import { rankedRepo } from '../ranked/ranked.repo.js';
import { statsService } from '../stats/stats.service.js';
import type { PublicProfileData } from './users.schemas.js';
import { progressionService } from '../progression/progression.service.js';
import type { RankedProfileResponse } from '../ranked/ranked.schemas.js';
import { friendsRepo } from '../friends/friends.repo.js';
import { storeRepo } from '../store/store.repo.js';
import { config } from '../../core/config.js';
import {
  getRequiredAvatarProductSlugs,
  parseStoredAvatarCustomization,
  type AvatarCustomization,
} from './avatar-customization.js';

interface UpdateProfileOptions {
  requesterRole?: string | null;
}

export interface AccountDeletionStatus {
  deletionRequestedAt: string;
  pendingDeletionAt: string;
}

function assertUserAccountActive(user: User): void {
  if (isUserAccountInactive(user)) {
    throw new AuthenticationError('Account is scheduled for deletion');
  }
}

async function buildIdentityBackfill(
  user: User,
  identity: AuthIdentity,
  detectedCountry?: string | null,
): Promise<UpdateUserData> {
  const backfill: UpdateUserData = {};
  if (!user.country && detectedCountry) {
    backfill.country = detectedCountry;
  }
  if (identity.phoneNumber) {
    if (user.phone_number !== identity.phoneNumber) {
      // Skip the phone backfill if the number is already held by another active
      // user — writing it would violate uq_users_phone_number_active and break
      // an otherwise-valid login. Explicit linking handles conflicts separately.
      const existing = await usersRepo.getActiveByPhoneNumber(identity.phoneNumber);
      if (!existing || existing.id === user.id) {
        backfill.phoneNumber = identity.phoneNumber;
        backfill.phoneVerifiedAt = identity.phoneVerifiedAt ?? new Date().toISOString();
      }
    } else if (!user.phone_verified_at) {
      backfill.phoneVerifiedAt = identity.phoneVerifiedAt ?? new Date().toISOString();
    }
  }
  return backfill;
}

async function assertAvatarCustomizationAllowed(
  userId: string,
  customization: AvatarCustomization | null | undefined,
  options?: UpdateProfileOptions
): Promise<void> {
  if (!customization) {
    return;
  }

  // Local-only admin bypass keeps development preview flows fast without weakening staging/prod.
  if (config.NODE_ENV === 'local' && options?.requesterRole === 'admin') {
    return;
  }

  const requiredSlugs = getRequiredAvatarProductSlugs(customization);
  if (requiredSlugs.length === 0) {
    return;
  }

  const inventory = await storeRepo.listInventoryWithProducts(userId);
  const ownedSlugs = new Set(inventory.map((item) => item.product_slug));
  const missingSlugs = requiredSlugs.filter((slug) => !ownedSlugs.has(slug));

  if (missingSlugs.length > 0) {
    throw new BadRequestError('Avatar customization includes unowned items', {
      missingProductSlugs: missingSlugs,
    });
  }
}

async function assertPhoneCanBeLinked(userId: string, phoneNumber: string): Promise<'available' | 'already_verified'> {
  const existing = await usersRepo.getActiveByPhoneNumber(phoneNumber);
  if (!existing) {
    return 'available';
  }
  if (existing.id !== userId) {
    throw new ConflictError('This phone number is already linked to another account', {
      field: 'phone',
    });
  }
  return existing.phone_verified_at ? 'already_verified' : 'available';
}

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
    const cached = await getCachedUser(identity.provider, identity.subject);
    if (cached) {
      assertUserAccountActive(cached);

      // Backfill missing fields for existing users
      const backfill = await buildIdentityBackfill(cached, identity, detectedCountry);

      if (Object.keys(backfill).length > 0) {
        const updated = await usersRepo.update(cached.id, backfill);
        if (updated) {
          try {
            await updateCachedUser(cached.id, updated);
          } catch (err) {
            logger.warn({ err, userId: cached.id }, 'Cache update failed (non-fatal)');
          }
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
      assertUserAccountActive(existingUser);

      // Backfill missing fields for existing users
      const backfill = await buildIdentityBackfill(existingUser, identity, detectedCountry);

      if (Object.keys(backfill).length > 0) {
        const updated = await usersRepo.update(existingUser.id, backfill);
        if (updated) {
          try {
            await setCachedUser(identity.provider, identity.subject, updated);
          } catch (err) {
            logger.warn({ err, userId: existingUser.id }, 'Cache update failed (non-fatal)');
          }
          logger.info({ userId: existingUser.id, ...backfill }, 'Backfilled user fields');
          return updated;
        }
      }

      try {
        await setCachedUser(identity.provider, identity.subject, existingUser);
      } catch (err) {
        logger.warn({ err, userId: existingUser.id }, 'Cache population failed (non-fatal)');
      }
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
        phoneNumber: identity.phoneNumber,
        phoneVerifiedAt: identity.phoneNumber
          ? identity.phoneVerifiedAt ?? new Date().toISOString()
          : null,
        nickname: identity.name,
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

    try {
      await setCachedUser(identity.provider, identity.subject, newUser);
    } catch (err) {
      logger.warn({ err, userId: newUser.id }, 'Cache population failed (non-fatal)');
    }
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

  async assertPhoneCanBeLinked(userId: string, phoneNumber: string): Promise<'available' | 'already_verified'> {
    return assertPhoneCanBeLinked(userId, phoneNumber);
  },

  async getVerifiedByPhoneNumber(phoneNumber: string): Promise<User | null> {
    const user = await usersRepo.getActiveByPhoneNumber(phoneNumber);
    if (!user || !user.phone_verified_at) {
      return null;
    }
    assertUserAccountActive(user);
    return user;
  },

  async setVerifiedPhoneNumber(userId: string, phoneNumber: string, verifiedAt?: string | null): Promise<User> {
    const availability = await assertPhoneCanBeLinked(userId, phoneNumber);
    if (availability === 'already_verified') {
      const current = await usersRepo.getById(userId);
      if (!current) {
        throw new NotFoundError('User not found');
      }
      return current;
    }

    const user = await usersRepo.update(userId, {
      phoneNumber,
      phoneVerifiedAt: verifiedAt ?? new Date().toISOString(),
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    try {
      await updateCachedUser(userId, user);
    } catch (err) {
      logger.warn({ err, userId }, 'Cache update failed (non-fatal)');
    }

    return user;
  },

  async assertPublicUserVisible(id: string): Promise<void> {
    const user = await usersRepo.getById(id);
    if (!user || isUserAccountInactive(user)) {
      throw new NotFoundError('User not found');
    }
  },

  /**
   * Update user profile.
   * Only allows updating: nickname, country, avatarUrl, favoriteClub, preferredLanguage
   */
  async updateProfile(
    id: string,
    data: Pick<UpdateUserData, 'nickname' | 'country' | 'avatarUrl' | 'avatarCustomization' | 'favoriteClub' | 'preferredLanguage'>,
    options?: UpdateProfileOptions
  ): Promise<User> {
    await assertAvatarCustomizationAllowed(id, data.avatarCustomization, options);

    if (typeof data.nickname === 'string' && data.nickname.trim().length > 0) {
      const taken = await usersRepo.isNicknameTaken(data.nickname, id);
      if (taken) {
        throw new ConflictError('Nickname is already taken', { field: 'nickname' });
      }
    }

    const user = await usersRepo.update(id, data);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Update cache with new user data (best-effort — don't fail the write).
    try {
      await updateCachedUser(id, user);
    } catch (err) {
      logger.warn({ err, userId: id }, 'Cache update failed (non-fatal)');
    }

    logger.debug({ userId: id }, 'Updated user profile');
    return user;
  },

  /**
   * Get public profile for a target user, including ranked, stats, and H2H with the viewer.
   */
  async getPublicProfile(targetUserId: string, viewerUserId: string): Promise<PublicProfileData> {
    const user = await usersRepo.getById(targetUserId);
    if (!user || isUserAccountInactive(user)) {
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
        avatar_customization: user.avatar_customization,
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
   * Search users by nickname substring. Excludes AI bots and the requester.
   */
  async searchByNickname(query: string, excludeUserId: string) {
    const rows = await usersRepo.searchByNickname(query, excludeUserId);
    const relationshipStatuses = await friendsRepo.getRelationshipStatuses(
      excludeUserId,
      rows.map((row) => row.id)
    );

    return rows.map((row) => ({
      id: row.id,
      nickname: row.nickname,
      avatarUrl: row.avatar_url,
      avatarCustomization: parseStoredAvatarCustomization(row.avatar_customization),
      level: progressionService.getProgression(row.total_xp).level,
      // Always false here — searchByNickname already filters deleted/pending rows.
      // The field exists for API shape parity with friend list / friend request results.
      pendingDeletion: false,
      ranked: row.ranked_tier && row.ranked_placement_status
        ? ({
            rp: row.ranked_rp ?? 0,
            tier: row.ranked_tier as RankedProfileResponse['tier'],
            placementStatus: row.ranked_placement_status,
            placementPlayed: row.ranked_placement_played ?? 0,
            placementRequired: row.ranked_placement_required ?? 0,
            placementWins: row.ranked_placement_wins ?? 0,
            currentWinStreak: row.ranked_current_win_streak ?? 0,
            lastRankedMatchAt: row.ranked_last_ranked_match_at,
          } satisfies RankedProfileResponse)
        : null,
      friendStatus: relationshipStatuses.get(row.id) ?? 'none',
    }));
  },

  /**
   * Mark onboarding as complete.
   */
  async completeOnboarding(id: string): Promise<User> {
    const user = await usersRepo.update(id, { onboardingComplete: true });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Update cache with new user data (best-effort).
    try {
      await updateCachedUser(id, user);
    } catch (err) {
      logger.warn({ err, userId: id }, 'Cache update failed (non-fatal)');
    }

    logger.info({ userId: id }, 'User completed onboarding');
    return user;
  },

  async requestAccountDeletion(id: string): Promise<AccountDeletionStatus> {
    const user = await usersRepo.requestDeletion(id);

    if (!user || !user.deletion_requested_at || !user.pending_deletion_at) {
      throw new NotFoundError('User not found');
    }

    await invalidateByUserId(id);

    // Best-effort: kick any open WebSocket sessions for this user so an open
    // browser tab can't keep playing matches after the account is locked.
    // Wrapped in try/catch defensively; the helper itself already swallows
    // its own errors but a future change might surface them.
    try {
      await disconnectUserSockets(id, 'account_deleted');
    } catch (err) {
      logger.warn({ err, userId: id }, 'Force-disconnect failed (non-fatal)');
    }

    logger.info({ userId: id, pendingDeletionAt: user.pending_deletion_at }, 'User requested account deletion');

    return {
      deletionRequestedAt: user.deletion_requested_at,
      pendingDeletionAt: user.pending_deletion_at,
    };
  },

  async resetOnboarding(id: string): Promise<User> {
    // Dev-only — mirrors the guard on /store/dev/grant-self. Even if a stale
    // route registration leaked into a non-local env, the service refuses.
    if (config.NODE_ENV !== 'local') {
      throw new NotFoundError('Not found');
    }

    const user = await usersRepo.update(id, { onboardingComplete: false });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    await invalidateByUserId(id);

    logger.info({ userId: id }, 'Admin reset onboarding');
    return user;
  },

  async restorePendingDeletion(id: string): Promise<User> {
    const user = await usersRepo.cancelPendingDeletion(id);

    if (!user) {
      throw new BadRequestError('Account is not pending deletion or grace period has expired');
    }

    await invalidateByUserId(id);
    logger.info({ userId: id }, 'Admin restored pending account deletion');
    return user;
  },
};
