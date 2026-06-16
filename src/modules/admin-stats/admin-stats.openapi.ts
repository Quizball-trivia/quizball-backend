import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { statsOverviewResponseSchema } from './admin-stats.schemas.js';

export function registerAdminStatsOpenApi(registry: OpenAPIRegistry): void {
  const response = statsOverviewResponseSchema.openapi('AdminStatsOverviewResponse');
  registry.register('AdminStatsOverviewResponse', response);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/stats/overview',
    summary: 'Admin dashboard stats: totals + 7-day signups/DAU/match trend',
    description:
      'Real-human (non-AI, non-seed, non-deleted) totals and a 7-day daily trend ' +
      'of signups, DAU (distinct users who played a match) and match volume.',
    tags: ['Admin'],
    responses: {
      200: { description: 'Stats overview', schema: response },
      401: { description: 'Unauthenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
    },
  });
}
