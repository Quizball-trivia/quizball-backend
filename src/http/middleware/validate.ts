import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ValidationError } from '../../core/errors.js';

/**
 * Schema configuration for request validation.
 */
interface ValidationSchema {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Validated data attached to request.
 */
interface ValidatedData {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

/**
 * Validation middleware factory.
 * Validates request body, query, and params against Zod schemas.
 * Attaches validated data to req.validated.
 *
 * Controllers should ALWAYS use req.validated.body, NEVER req.body directly.
 */
export function validate(schema: ValidationSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const validated: ValidatedData = {};

    try {
      if (schema.body) {
        const result = schema.body.safeParse(req.body);
        if (!result.success) {
          throw new ValidationError('Invalid request body', formatZodError(result.error));
        }
        validated.body = result.data;
      }

      if (schema.query) {
        const result = schema.query.safeParse(req.query);
        if (!result.success) {
          throw new ValidationError('Invalid query parameters', formatZodError(result.error));
        }
        validated.query = result.data;
      }

      if (schema.params) {
        const result = schema.params.safeParse(req.params);
        if (!result.success) {
          throw new ValidationError('Invalid path parameters', formatZodError(result.error));
        }
        validated.params = result.data;
      }

      // Attach validated data to request
      (req as Request & { validated: ValidatedData }).validated = validated;

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Format Zod error for response details.
 */
function formatZodError(error: ZodError): unknown {
  return {
    fieldErrors: error.flatten().fieldErrors,
    formErrors: error.flatten().formErrors,
  };
}

// Extend Express Request type
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      validated: ValidatedData;
    }
  }
}
