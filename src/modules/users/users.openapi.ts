import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { config } from '../../core/config.js';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { progressionResponseSchema } from '../progression/progression.schemas.js';
import {
  accountDeletionResponseSchema,
  achievementsResponseSchema,
  adminProgressionResultSchema,
  adminSetProgressionBodySchema,
  adminUsersListQuerySchema,
  adminUsersListResponseSchema,
  publicProfileResponseSchema,
  updateProfileSchema,
  userIdParamSchema,
  userResponseSchema,
  userSearchQuerySchema,
  userSearchResponseSchema,
} from './users.schemas.js';

export function registerUsersOpenApi(registry: OpenAPIRegistry): void {
  // Decorate once and register; reuse the decorated versions in path responses
  // so the generator emits $ref instead of inlining the full object.
  const progressionResponseOpenApiSchema = progressionResponseSchema.openapi('ProgressionResponse');
  const userResponseOpenApiSchema = userResponseSchema.openapi('UserResponse');
  const publicProfileResponseOpenApiSchema = publicProfileResponseSchema.openapi('PublicProfileResponse');
  const accountDeletionResponseOpenApiSchema = accountDeletionResponseSchema.openapi('AccountDeletionResponse');
  const achievementsResponseOpenApiSchema = achievementsResponseSchema.openapi('AchievementsResponse');
  registry.register('ProgressionResponse', progressionResponseOpenApiSchema);
  registry.register('UserResponse', userResponseOpenApiSchema);
  registry.register('PublicProfileResponse', publicProfileResponseOpenApiSchema);
  registry.register('AccountDeletionResponse', accountDeletionResponseOpenApiSchema);
  registry.register('AchievementsResponse', achievementsResponseOpenApiSchema);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/users/me',
    summary: 'Get current user profile',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'User profile', schema: userResponseOpenApiSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'put',
    path: '/api/v1/users/me',
    summary: 'Update current user profile',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    body: updateProfileSchema,
    responses: {
      200: { description: 'Profile updated', schema: userResponseOpenApiSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/users/me/complete-onboarding',
    summary: 'Mark onboarding as complete',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Onboarding completed', schema: userResponseOpenApiSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/users/me/deletion',
    summary: 'Schedule current user account for deletion',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Account deletion scheduled', schema: accountDeletionResponseOpenApiSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/users/{userId}/profile',
    summary: 'Get public profile for a user',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    pathParams: userIdParamSchema,
    responses: {
      200: { description: 'Public profile data', schema: publicProfileResponseOpenApiSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'User not found', schema: errorResponseSchema },
    },
  });

  if (config.NODE_ENV === 'local') {
    registerEndpoint(registry, {
      method: 'post',
      path: '/api/v1/users/me/reset-onboarding',
      summary: 'Reset onboarding flag for the current admin (dev-only)',
      description: "Dev-only. Requires admin role and NODE_ENV='local'. Flips onboarding_complete back to false so the onboarding flow can be re-tested. Operates on the caller's own user.",
      tags: ['Users'],
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Onboarding reset', schema: userResponseOpenApiSchema },
        401: { description: 'Not authenticated', schema: errorResponseSchema },
        403: { description: 'Insufficient permissions', schema: errorResponseSchema },
      },
    });
  }

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/users/{userId}/deletion/restore',
    summary: 'Restore a user account pending deletion',
    description: 'Requires admin role. Only works before the 30-day grace period expires.',
    tags: ['Admin Users'],
    security: [{ bearerAuth: [] }],
    pathParams: userIdParamSchema,
    responses: {
      200: { description: 'Account deletion cancelled', schema: userResponseOpenApiSchema },
      400: { description: 'Account is not restorable', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions', schema: errorResponseSchema },
      404: { description: 'User not found', schema: errorResponseSchema },
    },
  });

  const adminUsersListResponseOpenApiSchema = adminUsersListResponseSchema.openapi('AdminUsersListResponse');
  const adminProgressionResultOpenApiSchema = adminProgressionResultSchema.openapi('AdminProgressionResult');
  registry.register('AdminUsersListResponse', adminUsersListResponseOpenApiSchema);
  registry.register('AdminProgressionResult', adminProgressionResultOpenApiSchema);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/users',
    summary: 'List users with progression, RP and wallet',
    description: 'Requires admin role. Paginated and searchable by nickname/email.',
    tags: ['Admin Users'],
    security: [{ bearerAuth: [] }],
    query: adminUsersListQuerySchema,
    responses: {
      200: { description: 'Paginated users list', schema: adminUsersListResponseOpenApiSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'patch',
    path: '/api/v1/admin/users/{userId}/progression',
    summary: 'Set or grant a user XP and/or RP',
    description: 'Requires admin role. Records the acting admin id for audit. Each of xp/rp may be a set (absolute) or delta (grant).',
    tags: ['Admin Users'],
    security: [{ bearerAuth: [] }],
    pathParams: userIdParamSchema,
    body: adminSetProgressionBodySchema,
    responses: {
      200: { description: 'Progression updated', schema: adminProgressionResultOpenApiSchema },
      400: { description: 'Invalid adjustment request', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions', schema: errorResponseSchema },
      404: { description: 'User not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/users/me/achievements',
    summary: 'Get achievements for the current user',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Achievements list', schema: achievementsResponseOpenApiSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/users/{userId}/achievements',
    summary: 'Get achievements for a specific user',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    pathParams: userIdParamSchema,
    responses: {
      200: { description: 'Achievements list', schema: achievementsResponseOpenApiSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'User not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/users/search',
    summary: 'Search users by nickname',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    query: userSearchQuerySchema,
    responses: {
      200: { description: 'Search results', schema: userSearchResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });
}
