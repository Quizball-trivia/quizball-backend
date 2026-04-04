import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';
import { AppError, ErrorCode } from './errors.js';

// Load .env file
dotenvConfig();

const configSchema = z.object({
  NODE_ENV: z.enum(['local', 'staging', 'prod']).default('local'),
  PORT: z.coerce.number().default(8000),
  LOG_LEVEL: z.string().default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false', '1', '0', ''])
    .default('')
    .transform((val) => val === 'true' || val === '1'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  DEFAULT_LOCALE: z.string().default('en'),

  // Database
  DATABASE_URL: z.string().optional(),

  // Redis
  REDIS_URL: z.string().url().optional(),
  RANKED_HUMAN_QUEUE_ENABLED: z
    .enum(['true', 'false', '1', '0', ''])
    .default('false')
    .transform((val) => val === 'true' || val === '1'),
  RANKED_RP_V1_ENABLED: z
    .enum(['true', 'false', '1', '0', ''])
    .default('false')
    .transform((val) => val === 'true' || val === '1'),
  RANKED_PLACEMENT_AI_ONLY: z
    .enum(['true', 'false', '1', '0', ''])
    .default('true')
    .transform((val) => val === 'true' || val === '1'),
  RANKED_MM_RESPECT_RP: z
    .enum(['true', 'false', '1', '0', ''])
    .default('false')
    .transform((val) => val === 'true' || val === '1'),

  // Supabase
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // JWT Verification
  SUPABASE_JWKS_URL: z.string().url().optional(),
  SUPABASE_JWT_ISSUER: z.string().optional(),
  SUPABASE_JWT_AUDIENCE: z.string().optional(),
  SUPABASE_JWT_SECRET: z
    .string()
    .min(32, 'JWT secret must be at least 32 characters')
    .optional(),

  // Token Lifetimes
  // Refresh token cookie max age in milliseconds (default: 7 days)
  REFRESH_TOKEN_MAX_AGE_MS: z.coerce.number().positive().optional(),

  // API Docs (Swagger) - Basic Auth protection
  DOCS_ENABLED: z.enum(['true', 'false', '1', '0', '']).optional(),
  DOCS_USERNAME: z.string().optional(),
  DOCS_PASSWORD: z.string().optional(),

  // API Server URL (for OpenAPI documentation)
  API_BASE_URL: z.string().url().optional(),

  // OpenRouter (AI translation)
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('google/gemini-2.0-flash-001'),

  // Stripe (Store payments)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_SUCCESS_URL: z.string().url().optional(),
  STRIPE_CANCEL_URL: z.string().url().optional(),

  // Grafana Loki log shipping
  GRAFANA_LOKI_URL: z.string().url().optional(),
  GRAFANA_LOKI_USER: z.string().optional(),
  GRAFANA_LOKI_API_KEY: z.string().optional(),
  GRAFANA_LOKI_JOB: z.string().default('quizball-backend'),
});

type ConfigSchema = z.infer<typeof configSchema>;

export interface Config extends Omit<ConfigSchema, 'DOCS_ENABLED'> {
  DOCS_ENABLED: boolean;
}

class ConfigError extends AppError {
  constructor(message: string, details: unknown = null) {
    super(message, 500, ErrorCode.INTERNAL_ERROR, details);
  }
}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    const fieldErrors = result.error.flatten().fieldErrors;
    throw new ConfigError(
      `Invalid configuration: ${JSON.stringify(fieldErrors)}`,
      { fieldErrors }
    );
  }

  // Auto-disable docs in production unless explicitly enabled
  // Parse DOCS_ENABLED: true/1 = enabled, false/0 = disabled, undefined = auto (enabled except prod)
  const docsEnabled = result.data.DOCS_ENABLED === undefined
    ? result.data.NODE_ENV !== 'prod'
    : result.data.DOCS_ENABLED === 'true' || result.data.DOCS_ENABLED === '1';

  if (docsEnabled && result.data.NODE_ENV !== 'local') {
    const hasDocsUsername = !!result.data.DOCS_USERNAME?.trim();
    const hasDocsPassword = !!result.data.DOCS_PASSWORD?.trim();
    if (!hasDocsUsername || !hasDocsPassword) {
      throw new ConfigError(
        'Invalid configuration: DOCS_USERNAME and DOCS_PASSWORD are required when DOCS_ENABLED is true outside local environment.',
        {
          docsEnabled,
          nodeEnv: result.data.NODE_ENV,
          hasDocsUsername,
          hasDocsPassword,
        }
      );
    }
  }

  const hasAnyStripeConfig = Boolean(
    result.data.STRIPE_SECRET_KEY
    || result.data.STRIPE_WEBHOOK_SECRET
    || result.data.STRIPE_SUCCESS_URL
    || result.data.STRIPE_CANCEL_URL
  );

  if (hasAnyStripeConfig) {
    const requiredStripeVars = [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_SUCCESS_URL',
      'STRIPE_CANCEL_URL',
    ] as const;

    const missing = requiredStripeVars.filter((name) => {
      const value = result.data[name];
      return typeof value !== 'string' || value.trim() === '';
    });

    if (missing.length > 0) {
      throw new ConfigError(
        `Invalid configuration: missing required Stripe vars: ${missing.join(', ')}`,
        { missing }
      );
    }
  }

  const hasAnyLokiConfig = Boolean(
    result.data.GRAFANA_LOKI_URL
    || result.data.GRAFANA_LOKI_USER
    || result.data.GRAFANA_LOKI_API_KEY
  );

  if (hasAnyLokiConfig) {
    const requiredLokiVars = [
      'GRAFANA_LOKI_URL',
      'GRAFANA_LOKI_USER',
      'GRAFANA_LOKI_API_KEY',
    ] as const;

    const missing = requiredLokiVars.filter((name) => {
      const value = result.data[name];
      return typeof value !== 'string' || value.trim() === '';
    });

    if (missing.length > 0) {
      throw new ConfigError(
        `Invalid configuration: missing required Grafana Loki vars: ${missing.join(', ')}`,
        { missing }
      );
    }
  }

  return {
    ...result.data,
    DOCS_ENABLED: docsEnabled,
  };
}

export const config = parseConfig(process.env);
