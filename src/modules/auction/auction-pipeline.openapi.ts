import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { auctionPipelineStatsResponseSchema } from './auction-pipeline.schemas.js';

export function registerAuctionPipelineOpenApi(registry: OpenAPIRegistry): void {
  const statsResponse = auctionPipelineStatsResponseSchema.openapi('AuctionPipelineStatsResponse');

  registry.register('AuctionPipelineStatsResponse', statsResponse);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/auction-pipeline/stats',
    summary: 'Auction card generation pipeline status counters',
    tags: ['Auction'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Pipeline stage, attempt and coverage counters', schema: statsResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
    },
  });
}
