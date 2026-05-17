import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

/**
 * Side-effect import: extends Zod with `.openapi()` for spec generation.
 *
 * Every `*.openapi.ts` module imports this first so calls like
 * `z.string().openapi({...})` work regardless of module evaluation order.
 * Calling `extendZodWithOpenApi` multiple times is a no-op.
 */
extendZodWithOpenApi(z);
