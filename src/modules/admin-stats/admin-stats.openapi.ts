import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { analyticsOverviewResponseSchema, personsQuerySchema, personParamsSchema, personsResponseSchema, personActivityResponseSchema } from './admin-stats.schemas.js';

export function registerAdminStatsOpenApi(registry: OpenAPIRegistry): void {
  registry.register('AnalyticsOverviewResponse', analyticsOverviewResponseSchema.openapi('AnalyticsOverviewResponse'));

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/stats/persons',
    summary: 'Browse real registered users or playing guest journeys (admin)',
    tags: ['Admin Stats'], security: [{ bearerAuth: [] }], query: personsQuerySchema,
    responses: {
      200: { description: 'Paged person rows', schema: personsResponseSchema },
      401: { description: 'Authentication required', schema: errorResponseSchema },
      403: { description: 'Admin role required', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/stats/persons/{kind}/{id}/activity',
    summary: "One person's activity timeline from the production database (admin)",
    tags: ['Admin Stats'], security: [{ bearerAuth: [] }], pathParams: personParamsSchema,
    responses: {
      200: { description: 'Newest-first activity entries', schema: personActivityResponseSchema },
      401: { description: 'Authentication required', schema: errorResponseSchema },
      403: { description: 'Admin role required', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/stats/analytics-overview',
    summary: 'Real-numbers product analytics overview from the production database (admin)',
    tags: ['Admin Stats'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Totals, actives, 30-day series and country breakdown (Asia/Tbilisi days)', schema: analyticsOverviewResponseSchema },
      401: { description: 'Authentication required', schema: errorResponseSchema },
      403: { description: 'Admin role required', schema: errorResponseSchema },
    },
  });
}
