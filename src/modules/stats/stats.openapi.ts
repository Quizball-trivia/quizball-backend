import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  headToHeadQuerySchema,
  headToHeadResponseSchema,
  recentMatchesQuerySchema,
  recentMatchesResponseSchema,
  statsSummaryResponseSchema,
  partyRewardsParamsSchema,
  partyRewardsResponseSchema,
} from './stats.schemas.js';

export function registerStatsOpenApi(registry: OpenAPIRegistry): void {
  registerEndpoint(registry, {
    method: 'get', path: '/api/v1/stats/party-matches/{matchId}/rewards',
    summary: 'Read confirmed Party Quiz rewards for the authenticated participant',
    tags: ['Stats'], security: [{ bearerAuth: [] }], pathParams: partyRewardsParamsSchema,
    responses: {
      200: { description: 'Saved reward amounts and processing status', schema: partyRewardsResponseSchema },
      401: { description: 'Authentication required', schema: errorResponseSchema },
      404: { description: 'No completed Party Quiz match for this participant', schema: errorResponseSchema },
    },
  });
  // Register decorated copies for components.schemas, but pass the raw schemas
  // into route responses — matches the original registry.ts which used raw
  // schemas in paths (so they appear inlined) while the decorated copies
  // populate the components section.
  registry.register('HeadToHeadResponse', headToHeadResponseSchema.openapi('HeadToHeadResponse'));
  registry.register('RecentMatchesResponse', recentMatchesResponseSchema);
  registry.register('StatsSummaryResponse', statsSummaryResponseSchema.openapi('StatsSummaryResponse'));

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/stats/head-to-head',
    summary: 'Get head-to-head summary for two users',
    tags: ['Stats'],
    security: [{ bearerAuth: [] }],
    query: headToHeadQuerySchema,
    responses: {
      200: { description: 'Head-to-head summary', schema: headToHeadResponseSchema },
      401: { description: 'Authentication required', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/stats/recent-matches',
    summary: 'Get recent matches for authenticated user',
    tags: ['Stats'],
    security: [{ bearerAuth: [] }],
    query: recentMatchesQuerySchema,
    responses: {
      200: { description: 'Recent matches list', schema: recentMatchesResponseSchema },
      401: { description: 'Authentication required', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/stats/summary',
    summary: 'Get aggregate match stats for authenticated user',
    tags: ['Stats'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Aggregate stats summary', schema: statsSummaryResponseSchema },
      401: { description: 'Authentication required', schema: errorResponseSchema },
    },
  });
}
