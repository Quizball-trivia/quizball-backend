import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

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

  // API Docs (Swagger) - Basic Auth protection
  DOCS_ENABLED: z.enum(['true', 'false', '1', '0', '']).optional(),
  DOCS_USERNAME: z.string().optional(),
  DOCS_PASSWORD: z.string().optional(),

  // API Server URL (for OpenAPI documentation)
  API_BASE_URL: z.string().url().optional(),
});

type ConfigSchema = z.infer<typeof configSchema>;

export interface Config extends Omit<ConfigSchema, 'DOCS_ENABLED'> {
  DOCS_ENABLED: boolean;
}

function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid configuration:', result.error.flatten().fieldErrors);
    process.exit(1);
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
      console.error(
        'Invalid configuration: DOCS_USERNAME and DOCS_PASSWORD are required when DOCS_ENABLED is true outside local environment.'
      );
      process.exit(1);
    }
  }

  return {
    ...result.data,
    DOCS_ENABLED: docsEnabled,
  };
}

export const config = loadConfig();
