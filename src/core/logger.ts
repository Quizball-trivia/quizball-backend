import pino from 'pino';
import { config } from './config.js';
import { getRequestId } from './request-context.js';

/**
 * Pino logger with request_id injection via mixin.
 * Always uses pretty printing for readable logs.
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

  // Always use pretty printing for readable logs
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname,request_id',
      messageFormat: '{msg}',
      singleLine: true,
    },
  },
});

export type Logger = typeof logger;
