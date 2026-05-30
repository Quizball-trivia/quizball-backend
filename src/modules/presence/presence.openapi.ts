import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';

const onlineCountSchema = z
  .object({
    online: z.number().int().nonnegative(),
  })
  .openapi('OnlineCountResponse');

export function registerPresenceOpenApi(registry: OpenAPIRegistry): void {
  registry.register('OnlineCountResponse', onlineCountSchema);

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/presence/ping',
    summary: 'Heartbeat presence ping',
    description:
      'Records the caller (anonymous or logged-in) as currently online and returns ' +
      'the site-wide online count. Public — accepts requests without authentication.',
    tags: ['Presence'],
    responses: {
      200: { description: 'Online count', schema: onlineCountSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/presence/online',
    summary: 'Get site-wide online count',
    description: 'Returns the current count of visitors online site-wide.',
    tags: ['Presence'],
    responses: {
      200: { description: 'Online count', schema: onlineCountSchema },
    },
  });
}
