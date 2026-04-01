import pino, { type LoggerOptions } from 'pino';
import { trace } from '@opentelemetry/api';
import { config } from './config.js';
import { getRequestId } from './request-context.js';
import { getLokiLogStream } from './loki.js';

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
    const spanContext = trace.getActiveSpan()?.spanContext();
    return {
      request_id: getRequestId() ?? undefined,
      trace_id: spanContext?.traceId,
      span_id: spanContext?.spanId,
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
 * Pino logger with request_id injection via mixin and New Relic integration.
 * - In local/dev: Uses pino-pretty for human-readable console output
 * - In production: Uses structured JSON logs forwarded to New Relic
 */
let loggerInstance: pino.Logger;

if (usePrettyPrint) {
  // Development: Pretty console logs
  loggerInstance = pino({
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
  });
} else {
  const streams: Array<{ stream: NodeJS.WritableStream }> = [
    { stream: process.stdout },
  ];
  const lokiStream = getLokiLogStream();
  if (lokiStream) {
    streams.push({ stream: lokiStream });
  }

  // Production: JSON logs to stdout, optionally mirrored to Grafana Loki.
  loggerInstance = pino(baseOptions, pino.multistream(streams));

  // Trace/span IDs are injected from the active OpenTelemetry context in mixin().
}

export const logger = loggerInstance;

export type Logger = typeof logger;
