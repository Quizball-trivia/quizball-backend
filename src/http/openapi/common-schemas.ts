import './zod-init.js';
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Cross-module OpenAPI primitives. Each module's `*.openapi.ts` imports from
 * here so the same `ErrorResponse` schema and security scheme are reused
 * everywhere.
 */

export const errorResponseSchema = z
  .object({
    code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
    message: z.string().openapi({ example: 'Validation failed' }),
    details: z.any().nullable(),
    request_id: z.string().nullable().openapi({ example: 'uuid-here' }),
  })
  .openapi('ErrorResponse');

export function registerCommonSchemas(registry: OpenAPIRegistry): void {
  registry.register('ErrorResponse', errorResponseSchema);

  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });
}
