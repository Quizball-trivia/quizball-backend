import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { objectivesResponseSchema } from './objectives.schemas.js';

export function registerObjectivesOpenApi(registry: OpenAPIRegistry): void {
  registry.register('ObjectivesResponse', objectivesResponseSchema);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/objectives',
    summary: 'List current daily and weekly objectives for the current user',
    tags: ['Objectives'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Current objective progress', schema: objectivesResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });
}
