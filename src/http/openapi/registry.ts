import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

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

const userResponseSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email().nullable(),
    nickname: z.string().nullable(),
    country: z.string().nullable(),
    avatar_url: z.string().url().nullable(),
    onboarding_complete: z.boolean(),
    created_at: z.string().datetime(),
  })
  .openapi('UserResponse');

registry.register('UserResponse', userResponseSchema);

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
      content: { 'application/json': { schema: userResponseSchema } },
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
      content: {
        'application/json': {
          schema: z.object({
            nickname: z.string().min(1).max(50).optional(),
            country: z.string().min(2).max(100).optional(),
            avatar_url: z.string().url().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Profile updated',
      content: { 'application/json': { schema: userResponseSchema } },
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
      content: { 'application/json': { schema: userResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

// =============================================================================
// Category Schemas
// =============================================================================

const i18nFieldSchema = z.record(z.string(), z.string()).openapi('I18nField');

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

registry.register('I18nField', i18nFieldSchema);
registry.register('CategoryResponse', categoryResponseSchema);

// =============================================================================
// Question Schemas
// =============================================================================

const questionResponseSchema = z
  .object({
    id: z.string().uuid(),
    category_id: z.string().uuid(),
    type: z.enum(['mcq_single', 'input_text']),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    status: z.enum(['draft', 'published', 'archived']),
    prompt: i18nFieldSchema,
    explanation: i18nFieldSchema.nullable(),
    payload: z.any().nullable(),
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
    }),
  },
  responses: {
    200: {
      description: 'List of categories',
      content: { 'application/json': { schema: z.array(categoryResponseSchema) } },
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
  method: 'post',
  path: '/api/v1/categories',
  summary: 'Create a new category',
  tags: ['Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
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
  tags: ['Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
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
  tags: ['Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    204: {
      description: 'Category deleted',
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Category not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    409: {
      description: 'Category has children or questions',
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
      type: z.enum(['mcq_single', 'input_text']).optional(),
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
  tags: ['Questions'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            category_id: z.string().uuid(),
            type: z.enum(['mcq_single', 'input_text']),
            difficulty: z.enum(['easy', 'medium', 'hard']),
            status: z.enum(['draft', 'published', 'archived']).optional(),
            prompt: i18nFieldSchema,
            explanation: i18nFieldSchema.nullable().optional(),
            payload: z.any().optional(),
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
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/questions/{id}',
  summary: 'Update a question with payload',
  tags: ['Questions'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            category_id: z.string().uuid().optional(),
            type: z.enum(['mcq_single', 'input_text']).optional(),
            difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
            status: z.enum(['draft', 'published', 'archived']).optional(),
            prompt: i18nFieldSchema.optional(),
            explanation: i18nFieldSchema.nullable().optional(),
            payload: z.any().optional(),
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
  tags: ['Questions'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
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
    404: {
      description: 'Question not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

// =============================================================================
// Generate OpenAPI Document
// =============================================================================

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'QuizBall API',
      version: '1.0.0',
      description: 'QuizBall Backend API',
    },
    servers: [
      { url: 'http://localhost:8001', description: 'Local development' },
    ],
  });
}
