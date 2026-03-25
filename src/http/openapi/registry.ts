import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { i18nFieldSchema as baseI18nFieldSchema } from '../schemas/shared.js';
import { config } from '../../core/config.js';
import {
  headToHeadQuerySchema,
  headToHeadResponseSchema,
  recentMatchesQuerySchema,
  recentMatchesResponseSchema,
  statsSummaryResponseSchema,
} from '../../modules/stats/stats.schemas.js';
import {
  publicProfileResponseSchema,
  userIdParamSchema,
  userResponseSchema,
  userSearchQuerySchema,
  userSearchResponseSchema,
} from '../../modules/users/users.schemas.js';
import {
  listPublicLobbiesQuerySchema,
  listPublicLobbiesResponseSchema,
} from '../../modules/lobbies/lobbies.schemas.js';
import {
  rankedProfileResponseSchema,
} from '../../modules/ranked/ranked.schemas.js';
import {
  dailyChallengeMetadataSchema,
  listDailyChallengesResponseSchema,
  listAdminDailyChallengesResponseSchema,
  dailyChallengeSessionResponseSchema,
  completeDailyChallengeBodySchema,
  completeDailyChallengeResponseSchema,
  resetDailyChallengeResponseSchema,
  updateDailyChallengeConfigSchema,
  dailyChallengeParamSchema,
  dailyChallengeSettingsSchema,
} from '../../modules/daily-challenges/daily-challenges.schemas.js';
import {
  createCheckoutBodySchema,
  createCheckoutResponseSchema,
  purchaseWithCoinsBodySchema,
  purchaseWithCoinsResponseSchema,
  devGrantSelfBodySchema,
  devGrantSelfResponseSchema,
  listStoreTransactionsQuerySchema,
  listStoreTransactionsResponseSchema,
  manualAdjustmentBodySchema,
  manualAdjustmentResponseSchema,
  storeInventoryResponseSchema,
  storeProductsResponseSchema,
  storeTransactionLogResponseSchema,
  storeWalletResponseSchema,
} from '../../modules/store/store.schemas.js';
import {
  createFriendRequestBodySchema,
  createFriendRequestResponseSchema,
  friendActionResponseSchema,
  friendRequestIdParamSchema,
  friendRequestsResponseSchema,
  friendUserIdParamSchema,
  friendsResponseSchema,
} from '../../modules/friends/index.js';
import {
  questionTypeEnum,
} from '../../modules/questions/questions.schemas.js';
import { progressionResponseSchema } from '../../modules/progression/progression.schemas.js';

// Extend Zod with OpenAPI support
extendZodWithOpenApi(z);

/**
 * OpenAPI registry for manual route registration.
 */
export const registry = new OpenAPIRegistry();

// =============================================================================
// Common Schemas
// =============================================================================

const errorResponseSchema = z
  .object({
    code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
    message: z.string().openapi({ example: 'Validation failed' }),
    details: z.any().nullable(),
    request_id: z.string().nullable().openapi({ example: 'uuid-here' }),
  })
  .openapi('ErrorResponse');

registry.register('ErrorResponse', errorResponseSchema);

// =============================================================================
// Auth Schemas
// =============================================================================

const authUserSchema = z
  .object({
    email: z.string().email().nullable(),
    provider_sub: z.string(),
  })
  .openapi('AuthUser');

const authResponseSchema = z
  .object({
    access_token: z.string().nullable(),
    refresh_token: z.string().nullable(),
    expires_in: z.number().nullable(),
    token_type: z.string(),
    user: authUserSchema.nullable(),
    provider: z.string(),
  })
  .openapi('AuthResponse');

const messageResponseSchema = z
  .object({
    message: z.string(),
  })
  .openapi('MessageResponse');

const socialLoginResponseSchema = z
  .object({
    url: z.string().url(),
  })
  .openapi('SocialLoginResponse');

registry.register('AuthUser', authUserSchema);
registry.register('AuthResponse', authResponseSchema);
registry.register('MessageResponse', messageResponseSchema);
registry.register('SocialLoginResponse', socialLoginResponseSchema);

// =============================================================================
// User Schemas
// =============================================================================

const progressionResponseOpenApiSchema = progressionResponseSchema.openapi('ProgressionResponse');
const userResponseOpenApiSchema = userResponseSchema.openapi('UserResponse');
const headToHeadResponseOpenApiSchema = headToHeadResponseSchema.openapi('HeadToHeadResponse');
const statsSummaryResponseOpenApiSchema = statsSummaryResponseSchema.openapi('StatsSummaryResponse');
const rankedProfileResponseOpenApiSchema = rankedProfileResponseSchema.openapi('RankedProfileResponse');
const publicProfileResponseOpenApiSchema = publicProfileResponseSchema.openapi('PublicProfileResponse');

registry.register('ProgressionResponse', progressionResponseOpenApiSchema);
registry.register('UserResponse', userResponseOpenApiSchema);
registry.register('HeadToHeadResponse', headToHeadResponseOpenApiSchema);
registry.register('RecentMatchesResponse', recentMatchesResponseSchema);
registry.register('StatsSummaryResponse', statsSummaryResponseOpenApiSchema);
registry.register('RankedProfileResponse', rankedProfileResponseOpenApiSchema);
registry.register('PublicProfileResponse', publicProfileResponseOpenApiSchema);
registry.register('StoreProductsResponse', storeProductsResponseSchema);
registry.register('StoreWalletResponse', storeWalletResponseSchema);
registry.register('StoreInventoryResponse', storeInventoryResponseSchema);
registry.register('CreateCheckoutResponse', createCheckoutResponseSchema);
registry.register('PurchaseWithCoinsResponse', purchaseWithCoinsResponseSchema);
registry.register('ManualAdjustmentResponse', manualAdjustmentResponseSchema);
registry.register('StoreTransactionLogResponse', storeTransactionLogResponseSchema);
registry.register('ListStoreTransactionsResponse', listStoreTransactionsResponseSchema);
registry.register('FriendsResponse', friendsResponseSchema);
registry.register('FriendRequestsResponse', friendRequestsResponseSchema);
registry.register('CreateFriendRequestResponse', createFriendRequestResponseSchema);
registry.register('FriendActionResponse', friendActionResponseSchema);

// =============================================================================
// Security Schemes
// =============================================================================

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

// =============================================================================
// Auth Routes
// =============================================================================

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/register',
  summary: 'Register new user',
  tags: ['Auth'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().email(),
            password: z.string().min(8),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'User registered',
      content: { 'application/json': { schema: authResponseSchema } },
    },
    400: {
      description: 'Bad request',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/login',
  summary: 'Sign in with email and password',
  tags: ['Auth'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().email(),
            password: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Login successful',
      content: { 'application/json': { schema: authResponseSchema } },
    },
    401: {
      description: 'Authentication failed',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/refresh',
  summary: 'Refresh access token',
  tags: ['Auth'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            refresh_token: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Token refreshed',
      content: { 'application/json': { schema: authResponseSchema } },
    },
    401: {
      description: 'Invalid refresh token',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/forgot-password',
  summary: 'Send password reset email',
  tags: ['Auth'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().email(),
            redirect_to: z.string().url().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Reset email sent',
      content: { 'application/json': { schema: messageResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/reset-password',
  summary: 'Reset password',
  tags: ['Auth'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            access_token: z.string(),
            new_password: z.string().min(8),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Password reset successful',
      content: { 'application/json': { schema: messageResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/social-login',
  summary: 'Get OAuth authorization URL',
  tags: ['Auth'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            provider: z.enum(['google', 'apple', 'facebook', 'github']),
            redirect_to: z.string().url(),
            scopes: z.union([z.string(), z.array(z.string())]).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'OAuth URL returned',
      content: { 'application/json': { schema: socialLoginResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/logout',
  summary: 'Logout',
  tags: ['Auth'],
  responses: {
    200: {
      description: 'Logged out',
      content: { 'application/json': { schema: messageResponseSchema } },
    },
  },
});

// =============================================================================
// Stats Routes
// =============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/stats/head-to-head',
  summary: 'Get head-to-head summary for two users',
  tags: ['Stats'],
  security: [{ bearerAuth: [] }],
  request: {
    query: headToHeadQuerySchema,
  },
  responses: {
    200: {
      description: 'Head-to-head summary',
      content: { 'application/json': { schema: headToHeadResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/stats/recent-matches',
  summary: 'Get recent matches for authenticated user',
  tags: ['Stats'],
  security: [{ bearerAuth: [] }],
  request: {
    query: recentMatchesQuerySchema,
  },
  responses: {
    200: {
      description: 'Recent matches list',
      content: { 'application/json': { schema: recentMatchesResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/stats/summary',
  summary: 'Get aggregate match stats for authenticated user',
  tags: ['Stats'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Aggregate stats summary',
      content: { 'application/json': { schema: statsSummaryResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

// =============================================================================
// Lobbies Routes
// =============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/lobbies/public',
  summary: 'List public lobbies',
  tags: ['Lobbies'],
  security: [{ bearerAuth: [] }],
  request: {
    query: listPublicLobbiesQuerySchema,
  },
  responses: {
    200: {
      description: 'Public lobby list',
      content: { 'application/json': { schema: listPublicLobbiesResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

// =============================================================================
// Ranked Routes
// =============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/ranked/profile',
  summary: 'Get ranked profile for authenticated user',
  tags: ['Ranked'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Ranked profile',
      content: { 'application/json': { schema: rankedProfileResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

// =============================================================================
// Store Routes
// =============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/store/products',
  summary: 'List active store products',
  tags: ['Store'],
  responses: {
    200: {
      description: 'Active store products',
      content: { 'application/json': { schema: storeProductsResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/store/checkout',
  summary: 'Create Stripe checkout session',
  tags: ['Store'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: createCheckoutBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Checkout URL created',
      content: { 'application/json': { schema: createCheckoutResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Product not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    502: {
      description: 'Stripe checkout creation failed',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/store/purchase-coins',
  summary: 'Purchase non-coin-pack products with coin balance',
  tags: ['Store'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: purchaseWithCoinsBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Product purchased with coins',
      content: { 'application/json': { schema: purchaseWithCoinsResponseSchema } },
    },
    400: {
      description: 'Insufficient coins or invalid product type',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Product not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/store/wallet',
  summary: 'Get authenticated wallet balances',
  tags: ['Store'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Wallet balances',
      content: { 'application/json': { schema: storeWalletResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/store/inventory',
  summary: 'Get authenticated user inventory',
  tags: ['Store'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'User inventory',
      content: { 'application/json': { schema: storeInventoryResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/store/dev/grant-self',
  summary: 'Development-only self wallet grant',
  description: 'Local development helper for quickly granting coins/tickets to the authenticated user.',
  tags: ['Store'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: devGrantSelfBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated wallet after grant',
      content: { 'application/json': { schema: devGrantSelfResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Not available outside local environment',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/store/admin/adjustments',
  summary: 'Apply manual admin adjustment',
  description: 'Requires admin role',
  tags: ['Store Admin'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: manualAdjustmentBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Adjustment result',
      content: { 'application/json': { schema: manualAdjustmentResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    400: {
      description: 'Invalid adjustment request',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/store/admin/transactions',
  summary: 'List store transaction logs',
  description: 'Requires admin role',
  tags: ['Store Admin'],
  security: [{ bearerAuth: [] }],
  request: {
    query: listStoreTransactionsQuerySchema,
  },
  responses: {
    200: {
      description: 'Paginated store transaction logs',
      content: { 'application/json': { schema: listStoreTransactionsResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

// =============================================================================
// Users Routes
// =============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/users/me',
  summary: 'Get current user profile',
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'User profile',
      content: { 'application/json': { schema: userResponseOpenApiSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/users/me',
  summary: 'Update current user profile',
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            nickname: z.string().min(1).max(50).optional(),
            country: z.string().min(2).max(100).optional(),
            avatar_url: z.string().url().optional(),
            favorite_club: z.string().min(1).max(100).optional(),
            preferred_language: z.string().min(2).max(10).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Profile updated',
      content: { 'application/json': { schema: userResponseOpenApiSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/users/me/complete-onboarding',
  summary: 'Mark onboarding as complete',
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Onboarding completed',
      content: { 'application/json': { schema: userResponseOpenApiSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/users/{userId}/profile',
  summary: 'Get public profile for a user',
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  request: {
    params: userIdParamSchema,
  },
  responses: {
    200: {
      description: 'Public profile data',
      content: { 'application/json': { schema: publicProfileResponseOpenApiSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/users/search',
  summary: 'Search users by nickname',
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  request: {
    query: userSearchQuerySchema,
  },
  responses: {
    200: {
      description: 'Search results',
      content: { 'application/json': { schema: userSearchResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/friends',
  summary: 'List accepted friends for the authenticated user',
  tags: ['Friends'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Friends list',
      content: { 'application/json': { schema: friendsResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/friends/requests',
  summary: 'List incoming and outgoing friend requests',
  tags: ['Friends'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Friend request lists',
      content: { 'application/json': { schema: friendRequestsResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/friends/requests',
  summary: 'Send a friend request',
  tags: ['Friends'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: createFriendRequestBodySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Friend request created',
      content: { 'application/json': { schema: createFriendRequestResponseSchema } },
    },
    400: {
      description: 'Bad request',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Target user not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    409: {
      description: 'Friend request conflict',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/friends/requests/{requestId}/accept',
  summary: 'Accept a received friend request',
  tags: ['Friends'],
  security: [{ bearerAuth: [] }],
  request: {
    params: friendRequestIdParamSchema,
  },
  responses: {
    200: {
      description: 'Friend request accepted',
      content: { 'application/json': { schema: friendActionResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Friend request not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/friends/requests/{requestId}/decline',
  summary: 'Decline a received friend request',
  tags: ['Friends'],
  security: [{ bearerAuth: [] }],
  request: {
    params: friendRequestIdParamSchema,
  },
  responses: {
    200: {
      description: 'Friend request declined',
      content: { 'application/json': { schema: friendActionResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Friend request not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/friends/{friendUserId}',
  summary: 'Remove an existing friend',
  tags: ['Friends'],
  security: [{ bearerAuth: [] }],
  request: {
    params: friendUserIdParamSchema,
  },
  responses: {
    200: {
      description: 'Friend removed',
      content: { 'application/json': { schema: friendActionResponseSchema } },
    },
    400: {
      description: 'Bad request',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Friendship not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

// =============================================================================
// Category Schemas
// =============================================================================

// Extend shared i18nFieldSchema with OpenAPI metadata
const i18nFieldSchema = baseI18nFieldSchema.openapi('I18nField');

const categoryResponseSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    parent_id: z.string().uuid().nullable(),
    name: i18nFieldSchema,
    description: i18nFieldSchema.nullable(),
    icon: z.string().nullable(),
    image_url: z.string().url().nullable(),
    is_active: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi('CategoryResponse');

const paginatedCategoriesResponseSchema = z
  .object({
    data: z.array(categoryResponseSchema),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    total_pages: z.number().int().nonnegative(),
  })
  .openapi('PaginatedCategoriesResponse');

registry.register('I18nField', i18nFieldSchema);
registry.register('CategoryResponse', categoryResponseSchema);
registry.register('PaginatedCategoriesResponse', paginatedCategoriesResponseSchema);

const categoryDependenciesResponseSchema = z
  .object({
    children: z.array(
      z.object({
        id: z.string().uuid(),
        name: i18nFieldSchema,
        slug: z.string(),
      })
    ),
    questions: z.array(
      z.object({
        id: z.string().uuid(),
        prompt: i18nFieldSchema,
        type: z.string(),
        difficulty: z.string(),
      })
    ),
    featured: z.boolean(),
  })
  .openapi('CategoryDependenciesResponse');

registry.register('CategoryDependenciesResponse', categoryDependenciesResponseSchema);

// =============================================================================
// Question Schemas
// =============================================================================

const mcqOptionOpenApiSchema = z.object({
  id: z.string().min(1),
  text: i18nFieldSchema,
  is_correct: z.boolean(),
});

const mcqPayloadOpenApiSchema = z.object({
  type: z.literal('mcq_single'),
  options: z.array(mcqOptionOpenApiSchema).length(4),
});

const textInputPayloadOpenApiSchema = z.object({
  type: z.literal('input_text'),
  accepted_answers: z.array(i18nFieldSchema).min(1),
  case_sensitive: z.boolean(),
});

const countdownPayloadOpenApiSchema = z.object({
  type: z.literal('countdown_list'),
  prompt: i18nFieldSchema,
  answer_groups: z.array(
    z.object({
      id: z.string().min(1),
      display: i18nFieldSchema,
      accepted_answers: z.array(z.string().min(1)).min(1),
    })
  ).min(1),
});

const clueChainPayloadOpenApiSchema = z.object({
  type: z.literal('clue_chain'),
  display_answer: i18nFieldSchema,
  accepted_answers: z.array(z.string().min(1)).min(1),
  clues: z.array(
    z.object({
      type: z.enum(['text', 'emoji']),
      content: i18nFieldSchema,
    })
  ).min(1),
});

const putInOrderPayloadOpenApiSchema = z.object({
  type: z.literal('put_in_order'),
  prompt: i18nFieldSchema,
  direction: z.enum(['asc', 'desc']),
  items: z.array(
    z.object({
      id: z.string().min(1),
      label: i18nFieldSchema,
      details: i18nFieldSchema.nullable().optional(),
      emoji: z.string().nullable().optional(),
      sort_value: z.number(),
    })
  ).min(3),
});

const questionPayloadOpenApiSchema = z.discriminatedUnion('type', [
  mcqPayloadOpenApiSchema,
  textInputPayloadOpenApiSchema,
  countdownPayloadOpenApiSchema,
  clueChainPayloadOpenApiSchema,
  putInOrderPayloadOpenApiSchema,
]).openapi('QuestionPayload');

registry.register('QuestionPayload', questionPayloadOpenApiSchema);

const questionResponseSchema = z
  .object({
    id: z.string().uuid(),
    category_id: z.string().uuid(),
    type: questionTypeEnum,
    difficulty: z.enum(['easy', 'medium', 'hard']),
    status: z.enum(['draft', 'published', 'archived']),
    prompt: i18nFieldSchema,
    explanation: i18nFieldSchema.nullable(),
    payload: z.union([questionPayloadOpenApiSchema, z.null()]),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi('QuestionResponse');

const paginatedQuestionsResponseSchema = z
  .object({
    data: z.array(questionResponseSchema),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    total_pages: z.number().int().nonnegative(),
  })
  .openapi('PaginatedQuestionsResponse');

registry.register('QuestionResponse', questionResponseSchema);
registry.register('PaginatedQuestionsResponse', paginatedQuestionsResponseSchema);

// =============================================================================
// Categories Routes
// =============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/categories',
  summary: 'List all categories',
  tags: ['Categories'],
  request: {
    query: z.object({
      parent_id: z.string().uuid().optional(),
      is_active: z.string().optional(),
      min_questions: z.coerce.number().int().min(1).optional(),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: 'List of categories',
      content: { 'application/json': { schema: paginatedCategoriesResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/categories/{id}',
  summary: 'Get category by ID',
  tags: ['Categories'],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Category found',
      content: { 'application/json': { schema: categoryResponseSchema } },
    },
    404: {
      description: 'Category not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/categories/{id}/dependencies',
  summary: 'Get category dependencies',
  description: 'Returns child categories, associated questions, and featured status',
  tags: ['Categories'],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Category dependencies',
      content: { 'application/json': { schema: categoryDependenciesResponseSchema } },
    },
    404: {
      description: 'Category not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/categories',
  summary: 'Create a new category',
  description: 'Requires admin role',
  tags: ['Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            slug: z.string().min(1).max(100),
            parent_id: z.string().uuid().nullable().optional(),
            name: i18nFieldSchema,
            description: i18nFieldSchema.nullable().optional(),
            icon: z.string().max(100).nullable().optional(),
            image_url: z.string().url().nullable().optional(),
            is_active: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Category created',
      content: { 'application/json': { schema: categoryResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    409: {
      description: 'Slug already exists',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/categories/{id}',
  summary: 'Update a category',
  description: 'Requires admin role',
  tags: ['Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            slug: z.string().min(1).max(100).optional(),
            parent_id: z.string().uuid().nullable().optional(),
            name: i18nFieldSchema.optional(),
            description: i18nFieldSchema.nullable().optional(),
            icon: z.string().max(100).nullable().optional(),
            image_url: z.string().url().nullable().optional(),
            is_active: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Category updated',
      content: { 'application/json': { schema: categoryResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Category not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    409: {
      description: 'Slug already exists',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/categories/{id}',
  summary: 'Delete a category',
  description: 'Delete a category. Use cascade=true to also delete associated questions. Requires admin role.',
  tags: ['Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({
      cascade: z.string().optional().openapi({
        description: 'Set to "true" to delete associated questions before deleting the category',
        example: 'true',
      }),
    }),
  },
  responses: {
    204: {
      description: 'Category deleted',
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Category not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    409: {
      description: 'Category has children or questions (when cascade=false)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

// =============================================================================
// Featured Categories Schemas
// =============================================================================

const featuredCategoryResponseSchema = z
  .object({
    id: z.string().uuid(),
    category_id: z.string().uuid(),
    sort_order: z.number().int(),
    created_at: z.string().datetime(),
    category: categoryResponseSchema,
  })
  .openapi('FeaturedCategoryResponse');

registry.register('FeaturedCategoryResponse', featuredCategoryResponseSchema);

// =============================================================================
// Featured Categories Routes
// =============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/featured-categories',
  summary: 'List all featured categories',
  tags: ['Featured Categories'],
  responses: {
    200: {
      description: 'List of featured categories with joined category data',
      content: { 'application/json': { schema: z.array(featuredCategoryResponseSchema) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/featured-categories/{id}',
  summary: 'Get featured category by ID',
  tags: ['Featured Categories'],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Featured category found',
      content: { 'application/json': { schema: featuredCategoryResponseSchema } },
    },
    404: {
      description: 'Featured category not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/featured-categories',
  summary: 'Add a category to featured',
  description: 'Requires admin role',
  tags: ['Featured Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            category_id: z.string().uuid(),
            sort_order: z.number().int().min(0).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Category added to featured',
      content: { 'application/json': { schema: featuredCategoryResponseSchema } },
    },
    400: {
      description: 'Invalid category ID',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    409: {
      description: 'Category already featured',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/featured-categories/reorder',
  summary: 'Bulk reorder featured categories',
  description: 'Requires admin role',
  tags: ['Featured Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                sort_order: z.number().int().min(0),
              })
            ).min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Featured categories reordered',
      content: { 'application/json': { schema: z.array(featuredCategoryResponseSchema) } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'One or more featured category IDs not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/featured-categories/{id}',
  summary: 'Update featured category sort order',
  description: 'Requires admin role',
  tags: ['Featured Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            sort_order: z.number().int().min(0),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Featured category updated',
      content: { 'application/json': { schema: featuredCategoryResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Featured category not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/featured-categories/{id}',
  summary: 'Remove category from featured',
  description: 'Requires admin role',
  tags: ['Featured Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    204: {
      description: 'Category removed from featured',
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Featured category not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

// =============================================================================
// Questions Routes
// =============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/questions',
  summary: 'List questions with pagination and filters',
  tags: ['Questions'],
  request: {
    query: z.object({
      category_id: z.string().uuid().optional(),
      status: z.enum(['draft', 'published', 'archived']).optional(),
      difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
      type: questionTypeEnum.optional(),
      search: z.string().optional(),
      page: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Paginated list of questions',
      content: { 'application/json': { schema: paginatedQuestionsResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/questions/{id}',
  summary: 'Get question by ID with payload',
  tags: ['Questions'],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Question found',
      content: { 'application/json': { schema: questionResponseSchema } },
    },
    404: {
      description: 'Question not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/questions',
  summary: 'Create a new question with payload',
  description: 'Requires admin role',
  tags: ['Questions'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            category_id: z.string().uuid(),
            type: questionTypeEnum,
            difficulty: z.enum(['easy', 'medium', 'hard']),
            status: z.enum(['draft', 'published', 'archived']).optional(),
            prompt: i18nFieldSchema,
            explanation: i18nFieldSchema.nullable().optional(),
            payload: questionPayloadOpenApiSchema,
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Question created',
      content: { 'application/json': { schema: questionResponseSchema } },
    },
    400: {
      description: 'Invalid category',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

const bulkCreateResponseSchema = z
  .object({
    total: z.number().int(),
    successful: z.number().int(),
    failed: z.number().int(),
    created: z.array(questionResponseSchema),
    errors: z.array(
      z.object({
        index: z.number().int(),
        question: z.unknown(),
        error: z.string(),
      })
    ),
  })
  .openapi('BulkCreateResponse');

registry.register('BulkCreateResponse', bulkCreateResponseSchema);

registry.registerPath({
  method: 'post',
  path: '/api/v1/questions/bulk',
  summary: 'Bulk create questions',
  description: 'Create multiple questions in a single request. Maximum 100 questions per upload. Requires admin role.',
  tags: ['Questions'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            category_id: z.string().uuid(),
            questions: z
              .array(
                z.object({
                  type: questionTypeEnum,
                  difficulty: z.enum(['easy', 'medium', 'hard']),
                  status: z.enum(['draft', 'published', 'archived']).optional(),
                  prompt: i18nFieldSchema,
                  explanation: i18nFieldSchema.nullable().optional(),
                  payload: questionPayloadOpenApiSchema,
                })
              )
              .min(1)
              .max(100),
          }),
        },
      },
    },
  },
  responses: {
    207: {
      description: 'Questions created (may include partial failures)',
      content: {
        'application/json': {
          schema: bulkCreateResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid request or category not found',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: 'Not authenticated',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/questions/{id}',
  summary: 'Update a question with payload',
  description: 'Requires admin role',
  tags: ['Questions'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            category_id: z.string().uuid().optional(),
            type: questionTypeEnum.optional(),
            difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
            status: z.enum(['draft', 'published', 'archived']).optional(),
            prompt: i18nFieldSchema.optional(),
            explanation: i18nFieldSchema.nullable().optional(),
            payload: questionPayloadOpenApiSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Question updated',
      content: { 'application/json': { schema: questionResponseSchema } },
    },
    400: {
      description: 'Invalid category',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Question not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/questions/{id}',
  summary: 'Delete a question',
  description: 'Requires admin role',
  tags: ['Questions'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    204: {
      description: 'Question deleted',
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Question not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/questions/{id}/status',
  summary: 'Update question status',
  description: 'Requires admin role',
  tags: ['Questions'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['draft', 'published', 'archived']),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Status updated',
      content: { 'application/json': { schema: questionResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Question not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

// =============================================================================
// Duplicate Detection Schemas
// =============================================================================

const categorySummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .openapi('CategorySummary');

const duplicateGroupSchema = z
  .object({
    id: z.string(),
    type: z.enum(['cross_category', 'same_category']),
    prompt: z.string(),
    count: z.number().int(),
    questions: z.array(questionResponseSchema),
    categories: z.array(categorySummarySchema),
  })
  .openapi('DuplicateGroup');

const duplicatesResponseSchema = z
  .object({
    total_groups: z.number().int(),
    groups: z.array(duplicateGroupSchema),
  })
  .openapi('DuplicatesResponse');

const duplicateQuestionInfoSchema = z
  .object({
    id: z.string().uuid(),
    category_id: z.string().uuid(),
    category_name: i18nFieldSchema,
    created_at: z.string().datetime(),
  })
  .openapi('DuplicateQuestionInfo');

const checkDuplicatesResponseSchema = z
  .object({
    duplicates: z.array(
      z.object({
        index: z.number().int(),
        prompt: i18nFieldSchema,
        existingQuestions: z.array(duplicateQuestionInfoSchema),
      })
    ),
  })
  .openapi('CheckDuplicatesResponse');

registry.register('CategorySummary', categorySummarySchema);
registry.register('DuplicateGroup', duplicateGroupSchema);
registry.register('DuplicatesResponse', duplicatesResponseSchema);
registry.register('DuplicateQuestionInfo', duplicateQuestionInfoSchema);
registry.register('CheckDuplicatesResponse', checkDuplicatesResponseSchema);

// =============================================================================
// Duplicate Detection Routes
// =============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/questions/duplicates',
  summary: 'Find duplicate questions',
  description: 'Detect questions with identical prompt text. Returns groups of questions with the same prompt, either within the same category or across different categories. Requires admin role.',
  tags: ['Questions'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: z.enum(['cross_category', 'same_category', 'all']).optional().openapi({
        description: 'Filter by duplicate type',
        example: 'all',
      }),
      category_id: z.string().uuid().optional().openapi({
        description: 'Limit search to specific category',
      }),
      include_drafts: z.string().optional().openapi({
        description: 'Include draft questions in search (default: true)',
        example: 'true',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Duplicate groups found successfully',
      content: {
        'application/json': {
          schema: duplicatesResponseSchema,
        },
      },
    },
    401: {
      description: 'Not authenticated',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

// =============================================================================
// Daily Challenges Schemas
// =============================================================================

const dailyChallengeSettingsOpenApiSchema = dailyChallengeSettingsSchema.openapi('DailyChallengeSettings');

const adminDailyChallengeConfigResponseSchema = dailyChallengeMetadataSchema
  .extend({
    sortOrder: z.number().int(),
    isActive: z.boolean(),
    settings: dailyChallengeSettingsOpenApiSchema,
  })
  .openapi('AdminDailyChallengeConfigResponse');

registry.register('DailyChallengeMetadata', dailyChallengeMetadataSchema.openapi('DailyChallengeMetadata'));
registry.register('DailyChallengeSettings', dailyChallengeSettingsOpenApiSchema);
registry.register('DailyChallengeSessionResponse', dailyChallengeSessionResponseSchema.openapi('DailyChallengeSessionResponse'));
registry.register('CompleteDailyChallengeResponse', completeDailyChallengeResponseSchema.openapi('CompleteDailyChallengeResponse'));
registry.register('ResetDailyChallengeResponse', resetDailyChallengeResponseSchema.openapi('ResetDailyChallengeResponse'));
registry.register('AdminDailyChallengeConfigResponse', adminDailyChallengeConfigResponseSchema);

// =============================================================================
// Daily Challenge Routes
// =============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/daily-challenges',
  summary: 'List active daily challenges for the current user',
  tags: ['Daily Challenges'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Active daily challenge lineup',
      content: { 'application/json': { schema: listDailyChallengesResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/daily-challenges/{challengeType}/session',
  summary: 'Create a playable daily challenge session',
  tags: ['Daily Challenges'],
  security: [{ bearerAuth: [] }],
  request: {
    params: dailyChallengeParamSchema,
  },
  responses: {
    200: {
      description: 'Daily challenge session payload',
      content: { 'application/json': { schema: dailyChallengeSessionResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Challenge not available',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    409: {
      description: 'Already completed or content unavailable',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/daily-challenges/{challengeType}/complete',
  summary: 'Complete a daily challenge for the day',
  tags: ['Daily Challenges'],
  security: [{ bearerAuth: [] }],
  request: {
    params: dailyChallengeParamSchema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: completeDailyChallengeBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Completion recorded and rewards granted',
      content: { 'application/json': { schema: completeDailyChallengeResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Challenge not available',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    409: {
      description: 'Already completed today',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/daily-challenges/dev/{challengeType}/reset',
  summary: 'Reset today completion for a daily challenge (dev-only)',
  tags: ['Daily Challenges'],
  security: [{ bearerAuth: [] }],
  request: {
    params: dailyChallengeParamSchema,
  },
  responses: {
    200: {
      description: 'Today completion reset',
      content: { 'application/json': { schema: resetDailyChallengeResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Not allowed to use dev reset',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/daily-challenges',
  summary: 'List daily challenge CMS configs',
  tags: ['Admin Daily Challenges'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Admin daily challenge configs',
      content: { 'application/json': { schema: listAdminDailyChallengesResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/admin/daily-challenges/{challengeType}',
  summary: 'Update one daily challenge CMS config',
  tags: ['Admin Daily Challenges'],
  security: [{ bearerAuth: [] }],
  request: {
    params: dailyChallengeParamSchema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: updateDailyChallengeConfigSchema.extend({
            settings: dailyChallengeSettingsOpenApiSchema,
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated admin daily challenge config',
      content: { 'application/json': { schema: adminDailyChallengeConfigResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    403: {
      description: 'Insufficient permissions',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/questions/check-duplicates',
  summary: 'Check for duplicate prompts before bulk upload',
  description: 'Check if question prompts already exist in the database. Used during bulk upload preview to show users which questions are duplicates. Requires admin role.',
  tags: ['Questions'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            prompts: z.array(i18nFieldSchema).min(1).max(100).openapi({
              description: 'Array of question prompts to check',
              example: [
                { en: 'What is the capital of France?' },
                { en: 'What is 2+2?' },
              ],
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Duplicate check completed successfully',
      content: {
        'application/json': {
          schema: checkDuplicatesResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid request (e.g., too many prompts)',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: 'Not authenticated',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description: 'Insufficient permissions (admin role required)',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

// =============================================================================
// Generate OpenAPI Document
// =============================================================================

/**
 * Build OpenAPI servers array based on environment configuration.
 * Supports multiple environments (local, staging, production).
 */
function buildOpenApiServers(): Array<{ url: string; description: string }> {
  const servers: Array<{ url: string; description: string }> = [];

  // Add environment-specific URL if provided (e.g., staging/production)
  if (config.API_BASE_URL) {
    const envDescriptions: Record<string, string> = {
      local: 'Development Server',
      staging: 'Staging Server',
      prod: 'Production Server',
    };

    servers.push({
      url: config.API_BASE_URL,
      description: envDescriptions[config.NODE_ENV] || 'API Server',
    });
  }

  // Always include localhost for local development
  // Useful for developers even in staging/prod environments
  servers.push({
    url: `http://localhost:${config.PORT}`,
    description: 'Local development',
  });

  return servers;
}

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  const document = generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'QuizBall API',
      version: '1.0.0',
      description: 'QuizBall Backend API',
    },
    servers: buildOpenApiServers(),
  });

  const questionResponse = document.components?.schemas?.QuestionResponse as
    | {
        properties?: {
          payload?: unknown;
        };
      }
    | undefined;

  if (questionResponse?.properties) {
    questionResponse.properties.payload = {
      allOf: [{ $ref: '#/components/schemas/QuestionPayload' }],
      nullable: true,
    };
  }

  const userResponse = document.components?.schemas?.UserResponse as
    | {
        properties?: {
          progression?: unknown;
        };
      }
    | undefined;

  if (userResponse?.properties) {
    userResponse.properties.progression = {
      $ref: '#/components/schemas/ProgressionResponse',
    };
  }

  const publicProfileResponse = document.components?.schemas?.PublicProfileResponse as
    | {
        properties?: {
          progression?: unknown;
          ranked?: unknown;
          stats?: unknown;
          headToHead?: unknown;
        };
      }
    | undefined;

  if (publicProfileResponse?.properties) {
    publicProfileResponse.properties.progression = {
      $ref: '#/components/schemas/ProgressionResponse',
    };
    publicProfileResponse.properties.ranked = {
      allOf: [{ $ref: '#/components/schemas/RankedProfileResponse' }],
      nullable: true,
    };
    publicProfileResponse.properties.stats = {
      $ref: '#/components/schemas/StatsSummaryResponse',
    };
    publicProfileResponse.properties.headToHead = {
      allOf: [{ $ref: '#/components/schemas/HeadToHeadResponse' }],
      nullable: true,
    };
  }

  return document;
}
