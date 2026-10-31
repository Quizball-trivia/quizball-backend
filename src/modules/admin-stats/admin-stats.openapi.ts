import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { analyticsOverviewResponseSchema } from './admin-stats.schemas.js';

export function registerAdminStatsOpenApi(registry: OpenAPIRegistry): void {
  registry.register('AnalyticsOverviewResponse', analyticsOverviewResponseSchema.openapi('AnalyticsOverviewResponse'));

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
