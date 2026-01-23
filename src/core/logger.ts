import pino from 'pino';
import { config } from './config.js';
import { getRequestId } from './request-context.js';

/**
 * Pino logger with request_id injection via mixin.
 * The mixin() function is called on every log call and reads request_id from AsyncLocalStorage.
 */
export const logger = pino({
  level: config.LOG_LEVEL,

  // Mixin runs on EVERY log call, injecting request_id from AsyncLocalStorage
  mixin() {
    return {
      request_id: getRequestId() ?? 'no-request-id',
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

  // Prettier output in local environment
  transport:
    config.NODE_ENV === 'local'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

export type Logger = typeof logger;
