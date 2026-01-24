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

  // CORS with multi-origin support
  const allowedOrigins = (config.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
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
    // Cleaner log messages: "POST /api/v1/auth/login 200 (123ms)"
    customSuccessMessage: (req, res, responseTime) => {
      return `${req.method} ${req.url} ${res.statusCode} (${Math.round(responseTime as number)}ms)`;
    },
    customErrorMessage: (req, res, err) => {
      return `${req.method} ${req.url} ${res.statusCode} - ${err.message}`;
    },
    // Don't include req/res/responseTime objects in logs - already in message
    serializers: {
      req: () => undefined,
      res: () => undefined,
    },
    // Suppress responseTime attribute - we include it in the log message instead
    customAttributeKeys: {
      responseTime: undefined,
    },
  };
  app.use(pinoHttp(httpLoggerOptions));

  // General API Rate Limiting
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 300, // 300 requests per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later',
      details: null,
      request_id: null,
    },
  });
  app.use('/api/v1', apiLimiter);

  // Stricter Rate Limiting for auth routes
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many auth requests, please try again later',
      details: null,
      request_id: null,
    },
  });
  app.use('/api/v1/auth', authLimiter);

  // Disable ETag caching in development (forces fresh responses)
  if (process.env.NODE_ENV === 'development') {
    app.set('etag', false);
  }

  // Body Parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Routes
  app.use(routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
