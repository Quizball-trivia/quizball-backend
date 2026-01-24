import pino, { type LoggerOptions } from 'pino';
import { config } from './config.js';
import { getRequestId } from './request-context.js';

/**
 * Determine if pretty printing should be enabled:
 * 1. Explicit LOG_PRETTY=true takes precedence
 * 2. Otherwise, enable in local/development environments only
 * 3. Never use in containerized/production environments
 */
const isProduction = config.NODE_ENV === 'prod' || config.NODE_ENV === 'staging';
const isDocker = process.env.RAILWAY_ENVIRONMENT || process.env.DOCKER || process.env.KUBERNETES_SERVICE_HOST;
const usePrettyPrint = !isProduction && !isDocker && (config.LOG_PRETTY || config.NODE_ENV === 'local');

/**
 * Base logger options shared between pretty and JSON modes
 */
const baseOptions: LoggerOptions = {
  level: config.LOG_LEVEL,

  // Mixin runs on EVERY log call, injecting request_id from AsyncLocalStorage
  mixin() {
    return {
      request_id: getRequestId() ?? undefined,
    };
  },

  // Redact sensitive fields
  redact: {
    paths: [
      'req.headers.authorization',
      'password',
      'access_token',
      'refresh_token',
    ],
    censor: '[REDACTED]',
  },
};

/**
 * Pino logger with request_id injection via mixin.
 * - In local/dev: Uses pino-pretty for human-readable output
 * - In production: Uses structured JSON for log aggregation tools
 */
export const logger = usePrettyPrint
  ? pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: true,
        },
      },
    })
  : pino(baseOptions);

export type Logger = typeof logger;
