import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { rankedProfileResponseSchema } from './ranked.schemas.js';

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
}
