import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  adminDailyChallengeCategoryOptionSchema,
  completeDailyChallengeBodySchema,
  completeDailyChallengeResponseSchema,
  dailyChallengeConfigResponseSchema,
  dailyChallengeMetadataSchema,
  dailyChallengeParamSchema,
  dailyChallengeSessionResponseSchema,
  dailyChallengeSettingsSchema,
  listAdminDailyChallengesResponseSchema,
  listDailyChallengesResponseSchema,
  resetDailyChallengeResponseSchema,
  updateDailyChallengeConfigSchema,
} from './daily-challenges.schemas.js';

const dailyChallengeLocaleOpenApiQuerySchema = z.object({
  locale: z.string().min(2).max(16).optional(),
});

export function registerDailyChallengesOpenApi(registry: OpenAPIRegistry): void {
  const dailyChallengeSettingsOpenApiSchema = dailyChallengeSettingsSchema.openapi('DailyChallengeSettings');
  const adminDailyChallengeCategoryOptionOpenApiSchema = adminDailyChallengeCategoryOptionSchema.openapi('AdminDailyChallengeCategoryOption');
  const adminDailyChallengeConfigResponseOpenApiSchema = dailyChallengeConfigResponseSchema.openapi('AdminDailyChallengeConfigResponse');

  registry.register('DailyChallengeMetadata', dailyChallengeMetadataSchema.openapi('DailyChallengeMetadata'));
  registry.register('DailyChallengeSettings', dailyChallengeSettingsOpenApiSchema);
  registry.register('AdminDailyChallengeCategoryOption', adminDailyChallengeCategoryOptionOpenApiSchema);
  registry.register('DailyChallengeSessionResponse', dailyChallengeSessionResponseSchema.openapi('DailyChallengeSessionResponse'));
  registry.register('CompleteDailyChallengeResponse', completeDailyChallengeResponseSchema.openapi('CompleteDailyChallengeResponse'));
  registry.register('ResetDailyChallengeResponse', resetDailyChallengeResponseSchema.openapi('ResetDailyChallengeResponse'));
  registry.register('AdminDailyChallengeConfigResponse', adminDailyChallengeConfigResponseOpenApiSchema);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/daily-challenges',
    summary: 'List active daily challenges for the current user',
    tags: ['Daily Challenges'],
    security: [{ bearerAuth: [] }],
    query: dailyChallengeLocaleOpenApiQuerySchema,
    responses: {
      200: { description: 'Active daily challenge lineup', schema: listDailyChallengesResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/daily-challenges/{challengeType}/session',
    summary: 'Create a playable daily challenge session',
    tags: ['Daily Challenges'],
    security: [{ bearerAuth: [] }],
    pathParams: dailyChallengeParamSchema,
    query: dailyChallengeLocaleOpenApiQuerySchema,
    responses: {
      200: { description: 'Daily challenge session payload', schema: dailyChallengeSessionResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'Challenge not available', schema: errorResponseSchema },
      409: { description: 'Already completed or content unavailable', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/daily-challenges/{challengeType}/complete',
    summary: 'Complete a daily challenge for the day',
    tags: ['Daily Challenges'],
    security: [{ bearerAuth: [] }],
    pathParams: dailyChallengeParamSchema,
    body: completeDailyChallengeBodySchema,
    responses: {
      200: { description: 'Completion recorded and rewards granted', schema: completeDailyChallengeResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'Challenge not available', schema: errorResponseSchema },
      409: { description: 'Already completed today', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'delete',
    path: '/api/v1/daily-challenges/dev/{challengeType}/reset',
    summary: 'Reset today completion for a daily challenge (dev-only)',
    tags: ['Daily Challenges'],
    security: [{ bearerAuth: [] }],
    pathParams: dailyChallengeParamSchema,
    responses: {
      200: { description: 'Today completion reset', schema: resetDailyChallengeResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not allowed to use dev reset', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/daily-challenges',
    summary: 'List daily challenge CMS configs',
    tags: ['Admin Daily Challenges'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Admin daily challenge configs', schema: listAdminDailyChallengesResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'put',
    path: '/api/v1/admin/daily-challenges/{challengeType}',
    summary: 'Update one daily challenge CMS config',
    tags: ['Admin Daily Challenges'],
    security: [{ bearerAuth: [] }],
    pathParams: dailyChallengeParamSchema,
    body: updateDailyChallengeConfigSchema.extend({
      settings: dailyChallengeSettingsOpenApiSchema,
    }),
    responses: {
      200: { description: 'Updated admin daily challenge config', schema: adminDailyChallengeConfigResponseOpenApiSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions', schema: errorResponseSchema },
    },
  });
}
