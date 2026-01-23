import type { User } from '../../db/types.js';
import { usersRepo, type UpdateUserData } from './users.repo.js';
import { identitiesRepo } from './identities.repo.js';
import { NotFoundError } from '../../core/errors.js';
import type { AuthIdentity } from '../../core/types.js';
import { logger } from '../../core/logger.js';

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
   * 1. Look up UserIdentity by (provider, subject)
   * 2. If exists → return associated User
   * 3. If not → create User + UserIdentity, return User
   */
  async getOrCreateFromIdentity(identity: AuthIdentity): Promise<User> {
    // 1. Look up existing identity
    const existingIdentity = await identitiesRepo.getByProviderSubject(
      identity.provider,
      identity.subject
    );

    if (existingIdentity) {
      logger.debug(
        { userId: existingIdentity.user.id, provider: identity.provider },
        'Found existing user for identity'
      );
      return existingIdentity.user;
    }

    // 2. Create new user
    logger.info(
      { provider: identity.provider, subject: identity.subject },
      'Creating new user for identity'
    );

    const newUser = await usersRepo.create({
      email: identity.email,
    });

    // 3. Create identity mapping
    await identitiesRepo.create({
      userId: newUser.id,
      provider: identity.provider,
      subject: identity.subject,
      email: identity.email,
    });

    logger.info(
      { userId: newUser.id, provider: identity.provider },
      'Created new user and identity'
    );

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
   * Only allows updating: nickname, country, avatarUrl
   */
  async updateProfile(
    id: string,
    data: Pick<UpdateUserData, 'nickname' | 'country' | 'avatarUrl'>
  ): Promise<User> {
    const user = await usersRepo.update(id, data);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    logger.debug({ userId: id }, 'Updated user profile');
    return user;
  },

  /**
   * Mark onboarding as complete.
   */
  async completeOnboarding(id: string): Promise<User> {
    const user = await usersRepo.update(id, { onboardingComplete: true });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    logger.info({ userId: id }, 'User completed onboarding');
    return user;
  },
};
