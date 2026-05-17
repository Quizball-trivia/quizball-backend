import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  listPublicLobbiesQuerySchema,
  listPublicLobbiesResponseSchema,
} from './lobbies.schemas.js';

export function registerLobbiesOpenApi(registry: OpenAPIRegistry): void {
  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/lobbies/public',
    summary: 'List public lobbies',
    tags: ['Lobbies'],
    security: [{ bearerAuth: [] }],
    query: listPublicLobbiesQuerySchema,
    responses: {
      200: { description: 'Public lobby list', schema: listPublicLobbiesResponseSchema },
      401: { description: 'Authentication required', schema: errorResponseSchema },
    },
  });
}
