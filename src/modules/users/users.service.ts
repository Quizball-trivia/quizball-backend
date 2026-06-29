import type { User } from '../../db/types.js';
import { isUserAccountInactive, isUserBanned, usersRepo, type UpdateUserData } from './users.repo.js';
import { identitiesRepo } from './identities.repo.js';
import { AuthenticationError, BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import type { AuthIdentity } from '../../core/types.js';
import { logger } from '../../core/logger.js';
import { getRequestId } from '../../core/request-context.js';
import { getCachedUser, invalidateByUserId, setCachedUser, updateCachedUser } from './user-cache.js';
import { disconnectUserSockets } from '../../realtime/services/auth-realtime.service.js';
import { rankedRepo } from '../ranked/ranked.repo.js';
import { tierFromRp } from '../ranked/ranked.service.js';
import { statsService } from '../stats/stats.service.js';
import type {
  AdminProgressionResult,
  AdminSetProgressionBody,
  AdminUserListItem,
  AdminUsersListQuery,
  AdminUsersListResponse,
  PublicProfileData,
} from './users.schemas.js';
import type { Json } from '../../db/types.js';
import { progressionService } from '../progression/progression.service.js';
import type { RankedProfileResponse } from '../ranked/ranked.schemas.js';
import { friendsRepo } from '../friends/friends.repo.js';
import { storeRepo } from '../store/store.repo.js';
import { notificationsService } from '../notifications/notifications.service.js';
import { config } from '../../core/config.js';
import {
  getRequiredAvatarProductSlugs,
  parseStoredAvatarCustomization,
  type AvatarCustomization,
} from './avatar-customization.js';
import { findBannedNicknameTerm, isNicknameAllowed } from '../moderation/text-moderation.js';

interface UpdateProfileOptions {
  requesterRole?: string | null;
}

export interface AccountDeletionStatus {
  deletionRequestedAt: string;
  pendingDeletionAt: string;
}

const PENDING_DELETION_DETAILS = { reason: 'pending_deletion' } as const;

function isPendingDeletionAccount(user: Pick<User, 'is_deleted' | 'deleted_at' | 'pending_deletion_at'>): boolean {
  return Boolean(user.pending_deletion_at && !user.deleted_at && !user.is_deleted);
}

function assertUserAccountActive(user: User): void {
  // Ban is checked first so a banned account always sees the ban screen, even if
  // it is also (e.g.) pending deletion. `reason: 'banned'` is the discriminator
  // the web client branches on to render the ACCOUNT BANNED screen.
  if (isUserBanned(user)) {
    throw new AuthenticationError('Account is banned', { reason: 'banned' });
  }
  if (isPendingDeletionAccount(user)) {
    throw new AuthenticationError('Account is scheduled for deletion', PENDING_DELETION_DETAILS);
  }
  if (isUserAccountInactive(user)) {
    throw new AuthenticationError('Account is no longer active', { reason: 'account_inactive' });
  }
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function assertNicknameAllowed(nickname: string, userId?: string): void {
  const match = findBannedNicknameTerm(nickname);
  if (!match) return;

  logger.warn(
    {
      userId,
      field: 'nickname',
      reason: match.reason,
      language: match.language,
    },
    'Blocked prohibited nickname'
  );
  throw new BadRequestError('Nickname is not allowed', {
    field: 'nickname',
    reason: 'prohibited_content',
  });
}

async function buildIdentityBackfill(
  user: User,
  identity: AuthIdentity,
  detectedCountry?: string | null,
): Promise<UpdateUserData> {
  const backfill: UpdateUserData = {};
  const phoneNumber = normalizeOptionalText(identity.phoneNumber);
  if (!user.country && detectedCountry) {
    backfill.country = detectedCountry;
  }
  if (phoneNumber) {
    if (user.phone_number !== phoneNumber) {
      // Skip the phone backfill if the number is already held by another active
      // user — writing it would violate uq_users_phone_number_active and break
      // an otherwise-valid login. Explicit linking handles conflicts separately.
      const existing = await usersRepo.getActiveByPhoneNumber(phoneNumber);
      if (!existing || existing.id === user.id) {
        backfill.phoneNumber = phoneNumber;
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

  if (missingSlugs.length === 0) {
    return;
  }

  const currentUser = await usersRepo.getById(userId);
  const currentCustomization = parseStoredAvatarCustomization(currentUser?.avatar_customization);
  const alreadyEquippedSlugs = new Set(
    currentCustomization ? getRequiredAvatarProductSlugs(currentCustomization) : []
  );
  const newlyMissingSlugs = missingSlugs.filter((slug) => !alreadyEquippedSlugs.has(slug));

  if (newlyMissingSlugs.length > 0) {
    throw new BadRequestError('Avatar customization includes unowned items', {
      missingProductSlugs: newlyMissingSlugs,
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
 * Build and send the in-app notification for an admin XP/RP grant. Only the
 * fields that actually changed are mentioned. Best-effort: a notification
 * failure must not fail the underlying point change (which already committed).
 */
async function notifyProgressionChange(
  userId: string,
  change: { xpDelta: number; rpDelta: number; reason: string }
): Promise<void> {
  const parts: string[] = [];
  const partsKa: string[] = [];
  if (change.xpDelta !== 0) {
    parts.push(`${change.xpDelta > 0 ? '+' : ''}${change.xpDelta} XP`);
    partsKa.push(`${change.xpDelta > 0 ? '+' : ''}${change.xpDelta} XP`);
  }
  if (change.rpDelta !== 0) {
    parts.push(`${change.rpDelta > 0 ? '+' : ''}${change.rpDelta} RP`);
    partsKa.push(`${change.rpDelta > 0 ? '+' : ''}${change.rpDelta} RP`);
  }
  if (parts.length === 0) return;

  const summary = parts.join(' and ');
  try {
    await notificationsService.notify(userId, {
      type: 'points_adjustment',
      title: { en: 'Your rewards were updated', ka: 'შენი ჯილდოები განახლდა' },
      body: {
        en: `You received ${summary}.`,
        ka: `მიიღე ${partsKa.join(' და ')}.`,
      },
      data: { xpDelta: change.xpDelta, rpDelta: change.rpDelta, reason: change.reason },
    });
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to send progression-change notification');
  }
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
  async getOrCreateFromIdentity(
    identity: AuthIdentity,
    detectedCountry?: string | null,
    opts?: { onUserCreated?: (user: User) => void },
  ): Promise<User> {
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

    const phoneNumber = normalizeOptionalText(identity.phoneNumber);
    const normalizedIdentityNickname = normalizeOptionalText(identity.name);
    const proposedNickname =
      normalizedIdentityNickname && isNicknameAllowed(normalizedIdentityNickname)
        ? normalizedIdentityNickname
        : null;
    if (normalizedIdentityNickname && !proposedNickname) {
      logger.warn(
        {
          provider: identity.provider,
          subject: identity.subject,
          field: 'nickname',
          reason: 'prohibited_content',
        },
        'Dropped prohibited identity nickname during user creation'
      );
    }

    const newUser = await usersRepo.createWithIdentity(
      {
        email: identity.email,
        phoneNumber,
        phoneVerifiedAt: phoneNumber
          ? identity.phoneVerifiedAt ?? new Date().toISOString()
          : null,
        nickname: proposedNickname,
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

    // Authoritative new-account signal. Gated on the DB insert above, so it fires
    // exactly once per real account even though this method is called from auth,
    // middleware, and socket paths (and races on first login are idempotent).
    opts?.onUserCreated?.(newUser);

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

  /**
   * Admin: paginated list of real users with progression, ranked and wallet data.
   */
  async listUsersForAdmin(query: AdminUsersListQuery): Promise<AdminUsersListResponse> {
    const { items, total } = await usersRepo.listUsersForAdmin({
      search: query.search,
      page: query.page,
      limit: query.limit,
      orderBy: query.orderBy,
      orderDir: query.orderDir,
    });

    const mapped: AdminUserListItem[] = items.map((row) => {
      // total_xp is BIGINT — the pg driver returns it as a string. Coerce so the
      // API contract (number) holds and the CMS can do arithmetic on it.
      const totalXp = Number(row.total_xp);
      return {
        id: row.id,
        email: row.email,
        nickname: row.nickname,
        country: row.country,
        avatar_url: row.avatar_url,
        total_xp: totalXp,
        level: progressionService.getProgression(totalXp).level,
        rp: row.ranked_rp,
        tier: row.ranked_tier,
        placement_status: row.ranked_placement_status,
        coins: row.coins,
        tickets: row.tickets,
        created_at: row.created_at,
        is_banned: row.is_banned,
      };
    });

    return {
      items: mapped,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  },

  /**
   * Admin: set or grant a user's XP and/or RP. Final values are clamped to >= 0.
   * XP is a safe single-column write (level recomputes on read); RP also updates
   * the stored tier via tierFromRp. Every adjustment is recorded in
   * store_transaction_logs with the acting admin's id for audit.
   */
  async adminSetProgression(
    userId: string,
    body: AdminSetProgressionBody,
    options: { actorId: string }
  ): Promise<AdminProgressionResult> {
    const user = await usersRepo.getById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    // total_xp is BIGINT — coerce the pg string result to a number for arithmetic.
    const oldXp = Number(user.total_xp);
    let newXp = oldXp;
    if (body.xp) {
      const target = body.xp.mode === 'set' ? body.xp.value : oldXp + body.xp.value;
      newXp = Math.max(0, target);
      const written = await usersRepo.setTotalXp(userId, newXp);
      if (written === null) {
        throw new NotFoundError('User not found');
      }
      newXp = Number(written);
    }

    let oldRp: number | null = null;
    let newRp: number | null = null;
    let newTier: string | null = null;
    if (body.rp) {
      const profile = await rankedRepo.getProfile(userId);
      if (!profile) {
        throw new BadRequestError(
          'User has no ranked profile yet; RP cannot be set until they play a ranked match'
        );
      }
      oldRp = profile.rp;
      const target = body.rp.mode === 'set' ? body.rp.value : profile.rp + body.rp.value;
      const clampedRp = Math.max(0, target);
      const tier = tierFromRp(clampedRp);
      const written = await rankedRepo.setRankPoints(userId, clampedRp, tier);
      if (written === null) {
        throw new BadRequestError('User has no ranked profile yet; RP cannot be set');
      }
      newRp = written;
      newTier = tier;
    } else {
      const profile = await rankedRepo.getProfile(userId);
      oldRp = profile?.rp ?? null;
      newRp = profile?.rp ?? null;
      newTier = profile?.tier ?? null;
    }

    await storeRepo.insertTransactionLog({
      eventType: 'admin_progression_adjustment',
      outcome: 'success',
      userId,
      actorUserId: options.actorId,
      reason: body.reason,
      requestId: getRequestId(),
      metadata: {
        xp: body.xp ? { mode: body.xp.mode, value: body.xp.value, oldXp, newXp } : null,
        rp: body.rp ? { mode: body.rp.mode, value: body.rp.value, oldRp, newRp, newTier } : null,
      } as unknown as Json,
    });

    await invalidateByUserId(userId);

    if (body.notify) {
      const xpDelta = body.xp ? newXp - oldXp : 0;
      const rpDelta = body.rp && oldRp !== null && newRp !== null ? newRp - oldRp : 0;
      await notifyProgressionChange(userId, { xpDelta, rpDelta, reason: body.reason });
    }

    logger.info(
      { userId, actorId: options.actorId, oldXp, newXp, oldRp, newRp, reason: body.reason },
      'Admin progression adjustment applied'
    );

    return {
      userId,
      total_xp: newXp,
      level: progressionService.getProgression(newXp).level,
      rp: newRp,
      tier: newTier,
    };
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

  async getRestorableVerifiedByPhoneNumber(phoneNumber: string): Promise<User | null> {
    const user = await usersRepo.getActiveOrPendingByPhoneNumber(phoneNumber);
    if (!user || !user.phone_verified_at) {
      return null;
    }
    if (user.is_deleted || user.deleted_at) {
      return null;
    }
    return user;
  },

  async getPendingDeletionByEmail(email: string): Promise<User | null> {
    return usersRepo.getPendingDeletionByEmail(email);
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

    const updateData: typeof data = { ...data };
    if (typeof data.nickname === 'string') {
      const nickname = data.nickname.trim();
      if (nickname.length === 0) {
        throw new BadRequestError('Nickname is required', {
          field: 'nickname',
          reason: 'empty',
        });
      }
      assertNicknameAllowed(nickname, id);
      const taken = await usersRepo.isNicknameTaken(nickname, id);
      if (taken) {
        throw new ConflictError('Nickname is already taken', { field: 'nickname' });
      }
      updateData.nickname = nickname;
    }

    const user = await usersRepo.update(id, updateData);

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

  /**
   * Admin: soft-ban an account. Blocks login (enforced in assertUserAccountActive)
   * while preserving ALL history so the ban can be lifted later. Snapshots the
   * account's current RP/tier/placement into ban_metadata and zeroes RP so the
   * banned account stops polluting the leaderboard; unbanUser restores it.
   * Idempotent: re-banning an already-banned account refreshes reason but does
   * NOT re-snapshot RP (it's already 0), so the original RP survives.
   */
  async banUser(
    id: string,
    options: { reason?: string | null; actorId: string; zeroRp?: boolean }
  ): Promise<User> {
    const existing = await usersRepo.getById(id);
    if (!existing) {
      throw new NotFoundError('User not found');
    }

    const zeroRp = options.zeroRp ?? true;
    const alreadyBanned = isUserBanned(existing);

    // Snapshot RP only on the first ban — re-banning must not capture the
    // already-zeroed RP and clobber the real pre-ban value in ban_metadata.
    let metadata: Json | null =
      (existing.ban_metadata as Json | null) ?? null;
    if (zeroRp && !alreadyBanned) {
      const profile = await rankedRepo.getProfile(id);
      metadata = {
        prev_rp: profile?.rp ?? null,
        prev_tier: profile?.tier ?? null,
        prev_placement: profile?.placement_status ?? null,
        snapshot_at: new Date().toISOString(),
      } as unknown as Json;
      if (profile) {
        await rankedRepo.setRankPoints(id, 0, tierFromRp(0));
      }
    }

    const user = await usersRepo.setBanState(id, true, {
      reason: options.reason ?? null,
      metadata,
    });
    if (!user) {
      throw new NotFoundError('User not found');
    }

    await storeRepo.insertTransactionLog({
      eventType: 'admin_account_ban',
      outcome: 'success',
      userId: id,
      actorUserId: options.actorId,
      reason: options.reason ?? null,
      requestId: getRequestId(),
      metadata: { banned: true, zeroedRp: zeroRp, snapshot: metadata } as unknown as Json,
    });

    await invalidateByUserId(id);

    // Kick any open sockets so an in-progress session can't keep playing.
    try {
      await disconnectUserSockets(id, 'banned');
    } catch (err) {
      logger.warn({ err, userId: id }, 'Force-disconnect on ban failed (non-fatal)');
    }

    logger.info({ userId: id, actorId: options.actorId, reason: options.reason }, 'Admin banned account');
    return user;
  },

  /**
   * Admin: lift a ban and restore the RP that was snapshotted at ban time.
   */
  async unbanUser(id: string, options: { actorId: string }): Promise<User> {
    const existing = await usersRepo.getById(id);
    if (!existing) {
      throw new NotFoundError('User not found');
    }
    if (!isUserBanned(existing)) {
      throw new BadRequestError('Account is not banned');
    }

    const snapshot = (existing.ban_metadata as { prev_rp?: number | null } | null) ?? null;
    const prevRp = typeof snapshot?.prev_rp === 'number' ? snapshot.prev_rp : null;
    if (prevRp !== null) {
      const profile = await rankedRepo.getProfile(id);
      if (profile) {
        await rankedRepo.setRankPoints(id, prevRp, tierFromRp(prevRp));
      }
    }

    const user = await usersRepo.setBanState(id, false);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    await storeRepo.insertTransactionLog({
      eventType: 'admin_account_unban',
      outcome: 'success',
      userId: id,
      actorUserId: options.actorId,
      reason: null,
      requestId: getRequestId(),
      metadata: { banned: false, restoredRp: prevRp } as unknown as Json,
    });

    await invalidateByUserId(id);
    logger.info({ userId: id, actorId: options.actorId, restoredRp: prevRp }, 'Admin unbanned account');
    return user;
  },

  async restorePendingDeletionFromIdentity(identity: AuthIdentity): Promise<User> {
    const existingIdentity = await identitiesRepo.getByProviderSubject(
      identity.provider,
      identity.subject
    );

    if (!existingIdentity) {
      throw new BadRequestError('No restorable account found for this login');
    }

    const user = existingIdentity.user;
    if (!isPendingDeletionAccount(user)) {
      assertUserAccountActive(user);
      return user;
    }

    const restored = await usersRepo.cancelPendingDeletion(user.id);
    if (!restored) {
      throw new BadRequestError('Account is not pending deletion or grace period has expired');
    }

    await invalidateByUserId(restored.id);
    logger.info(
      { userId: restored.id, provider: identity.provider },
      'User restored pending account deletion'
    );
    return restored;
  },
};
