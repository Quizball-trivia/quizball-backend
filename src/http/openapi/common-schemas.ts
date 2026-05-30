import './zod-init.js';
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { i18nFieldSchema as baseI18nFieldSchema } from '../schemas/shared.js';

/**
 * Cross-module OpenAPI primitives. Each module's `*.openapi.ts` imports from
 * here so the same `ErrorResponse` schema, `I18nField` and security scheme are
 * reused everywhere.
 */

export const errorResponseSchema = z
  .object({
    code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
    message: z.string().openapi({ example: 'Validation failed' }),
    details: z.any().nullable(),
    request_id: z.string().nullable().openapi({ example: 'uuid-here' }),
  })
  .openapi('ErrorResponse');

export const i18nFieldSchema = baseI18nFieldSchema.openapi('I18nField');

export function registerCommonSchemas(registry: OpenAPIRegistry): void {
  registry.register('ErrorResponse', errorResponseSchema);
  registry.register('I18nField', i18nFieldSchema);

  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  registry.registerComponent('securitySchemes', 'smsCallbackSecret', {
    type: 'apiKey',
    in: 'query',
    name: 'secret',
  });
}
