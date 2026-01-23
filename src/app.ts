import 'express-async-errors';
import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { pinoHttp, type Options } from 'pino-http';
import type { IncomingMessage } from 'node:http';

import { config } from './core/config.js';
import { logger } from './core/logger.js';
import {
  requestIdMiddleware,
  errorHandler,
  notFoundHandler,
} from './http/middleware/index.js';
import { routes } from './http/routes/index.js';

/**
 * Create and configure the Express application.
 */
export function createApp(): Express {
  const app = express();

  // Security headers
  app.use(helmet());

  // CORS
  app.use(
    cors({
      origin: config.CORS_ORIGIN,
      credentials: true,
    })
  );

  app.use(requestIdMiddleware);

  // Request Logging (pino-http with our logger)
  const httpLoggerOptions: Options = {
    logger,
    // Don't log health checks to reduce noise
    autoLogging: {
      ignore: (req: IncomingMessage) => req.url === '/health',
    },
  };
  app.use(pinoHttp(httpLoggerOptions));

  // Rate Limiting (only for /api/v1/auth/*)
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later',
      details: null,
      request_id: null, // Will be set by error handler
    },
  });
  app.use('/api/v1/auth', authLimiter);

  // Body Parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Routes
  app.use(routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
