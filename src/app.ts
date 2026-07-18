import 'express-async-errors';
import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { pinoHttp, type Options } from 'pino-http';
import type { IncomingMessage } from 'node:http';
import cookieParser from 'cookie-parser';

import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { AuthorizationError } from './core/errors.js';
import { analyticsMiddleware } from './http/middleware/analytics.middleware.js';
import { createStoreWebhookRouter, stripe as storeStripe } from './modules/store/index.js';
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

  // Trust exactly the ingress hop in front of the app. `true` trusts arbitrary
  // caller-supplied X-Forwarded-For chains and lets attackers rotate req.ip,
  // bypassing our per-IP rate limit. Supabase forwarding separately uses only
  // Railway's documented X-Real-IP header (see http/client-ip.ts).
  app.set('trust proxy', 1);

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
          callback(new AuthorizationError('CORS origin not allowed'));
        }
      },
      credentials: true,
    })
  );

  // Cookie parsing (for httpOnly auth cookies)
  app.use(cookieParser());

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
    // Attach user info to every request log
    customProps: (req) => {
      const expressReq = req as unknown as import('express').Request;
      if (expressReq.user) {
        return { userId: expressReq.user.id, userRole: expressReq.user.role };
      }
      return {};
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

  // Analytics tracking (PostHog)
  app.use(analyticsMiddleware);

  // Stripe webhook must be registered before /api/v1 rate limiter and body parsers.
  if (storeStripe && config.STRIPE_WEBHOOK_SECRET) {
    app.use(createStoreWebhookRouter(storeStripe));
  }

  // Rate limiting is disabled only for the loopback/local development stack.
  // NODE_ENV is intentionally constrained to local|staging|prod, so checking
  // for the conventional but invalid "development" value never disabled it.
  if (config.NODE_ENV !== 'local') {
    // Load-test bypass: skip the limiter only when a NON-PROD env secret is set
    // and the request presents the matching header. Prod can never bypass — the
    // token is ignored when NODE_ENV==='prod', so a leaked header is inert there.
    const chaosBypassToken =
      config.NODE_ENV !== 'prod' ? config.CHAOS_BYPASS_TOKEN : undefined;
    const skipForChaos = (req: express.Request): boolean =>
      Boolean(chaosBypassToken) && req.get('x-chaos-bypass') === chaosBypassToken;
    if (chaosBypassToken) {
      logger.warn(
        'CHAOS_BYPASS_TOKEN is set — rate limiting can be bypassed via x-chaos-bypass header (non-prod only).'
      );
    }

    // General API Rate Limiting
    const apiLimiter = rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 300, // 300 requests per window per IP
      standardHeaders: true,
      legacyHeaders: false,
      skip: skipForChaos,
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
      skip: skipForChaos,
      message: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many auth requests, please try again later',
        details: null,
        request_id: null,
      },
    });
    app.use('/api/v1/auth', authLimiter);

    // Tight limiter for the public feedback endpoint to deter spam (it relays
    // to email). A handful of submissions per 10 min per IP is plenty.
    const feedbackLimiter = rateLimit({
      windowMs: 10 * 60 * 1000, // 10 minutes
      max: 5, // 5 submissions per window per IP
      standardHeaders: true,
      legacyHeaders: false,
      skip: skipForChaos,
      message: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many feedback submissions, please try again later',
        details: null,
        request_id: null,
      },
    });
    app.use('/api/v1/feedback', feedbackLimiter);
  }

  // Disable ETag caching in development (forces fresh responses)
  if (process.env.NODE_ENV === 'development') {
    app.set('etag', false);
  }

  // Body Parsing
  app.use(express.json({
    limit: '500mb',
    verify: (req, _res, buf) => {
      // Supabase Auth HTTP hooks are signed over the exact raw JSON payload.
      (req as express.Request).rawBody = buf.toString('utf8');
    },
  }));
  app.use(express.urlencoded({ extended: true, limit: '500mb' }));

  // Routes
  app.use(routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
