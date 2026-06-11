import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  leaderboardResetBodySchema,
  leaderboardResetResponseSchema,
  rankedProfileResponseSchema,
} from './ranked.schemas.js';

export function registerRankedOpenApi(registry: OpenAPIRegistry): void {
  registry.register('RankedProfileResponse', rankedProfileResponseSchema.openapi('RankedProfileResponse'));

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/ranked/profile',
    summary: 'Get ranked profile for authenticated user',
    tags: ['Ranked'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Ranked profile', schema: rankedProfileResponseSchema },
      401: { description: 'Authentication required', schema: errorResponseSchema },
    },
  });

  const leaderboardResetResponseOpenApiSchema = leaderboardResetResponseSchema.openapi('LeaderboardResetResponse');
  registry.register('LeaderboardResetResponse', leaderboardResetResponseOpenApiSchema);

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/leaderboard/reset',
    summary: 'Reset the global leaderboard (ranks & placement)',
    description: "Requires admin role. Archives current standings into the reset archive tables, then sets every real user's RP to 0 (tier 'Academy') and clears placement progress so all users re-do placement.",
    tags: ['Admin Leaderboard'],
    security: [{ bearerAuth: [] }],
    body: leaderboardResetBodySchema,
    responses: {
      200: { description: 'Leaderboard reset summary', schema: leaderboardResetResponseOpenApiSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions', schema: errorResponseSchema },
    },
  });
}
