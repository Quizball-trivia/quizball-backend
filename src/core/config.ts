import { config as dotenvConfig } from "dotenv";
import { z } from "zod";
import { AppError, ErrorCode } from "./errors.js";

// Load .env file
dotenvConfig();

const configSchema = z.object({
  NODE_ENV: z.enum(["local", "staging", "prod"]).default("local"),
  PORT: z.coerce.number().default(8000),
  LOG_LEVEL: z.string().default("info"),
  LOG_PRETTY: z
    .enum(["true", "false", "1", "0", ""])
    .default("")
    .transform((val) => val === "true" || val === "1"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  DEFAULT_LOCALE: z.string().default("en"),

  // Database
  DATABASE_URL: z.string().optional(),
  STAGING_DATABASE_URL: z.string().optional(),

  // Redis
  REDIS_URL: z.string().url().optional(),
  RANKED_HUMAN_QUEUE_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  RANKED_PLACEMENT_AI_ONLY: z
    .enum(["true", "false", "1", "0", ""])
    .default("true")
    .transform((val) => val === "true" || val === "1"),
  RANKED_MM_RESPECT_RP: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((val) => val === "true" || val === "1"),

  // When false, objectives stop progressing and stop awarding coins/XP after
  // matches (paired with hiding the Objectives UI behind the frontend flag).
  OBJECTIVES_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("true")
    .transform((val) => val !== "false" && val !== "0"),

  // Supabase
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SMSOFFICE_API_KEY: z.string().optional(),
  SMSOFFICE_SENDER: z.string().default("QuizBall"),
  SMSOFFICE_DRY_RUN: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  SMSOFFICE_CALLBACK_SECRET: z.string().optional(),
  SUPABASE_SMS_HOOK_SECRET: z.string().optional(),

  // JWT Verification
  SUPABASE_JWKS_URL: z.string().url().optional(),
  SUPABASE_JWT_ISSUER: z.string().optional(),
  SUPABASE_JWT_AUDIENCE: z.string().optional(),
  SUPABASE_JWT_SECRET: z
    .string()
    .min(32, "JWT secret must be at least 32 characters")
    .optional(),

  // Token Lifetimes
  // Refresh token cookie max age in milliseconds (default: 7 days)
  REFRESH_TOKEN_MAX_AGE_MS: z.coerce.number().positive().optional(),

  // API Docs (Swagger) - Basic Auth protection
  DOCS_ENABLED: z.enum(["true", "false", "1", "0", ""]).optional(),
  DOCS_USERNAME: z.string().optional(),
  DOCS_PASSWORD: z.string().optional(),

  // API Server URL (for OpenAPI documentation)
  API_BASE_URL: z.string().url().optional(),

  // OpenRouter (AI translation)
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("google/gemini-2.0-flash-001"),

  // Stripe (Store payments)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_SUCCESS_URL: z.string().url().optional(),
  STRIPE_CANCEL_URL: z.string().url().optional(),

  // Grafana Loki log shipping
  GRAFANA_LOKI_URL: z.string().url().optional(),
  GRAFANA_LOKI_USER: z.string().optional(),
  GRAFANA_LOKI_API_KEY: z.string().optional(),
  GRAFANA_LOKI_JOB: z.string().default("quizball-backend"),

  // Resend transactional email (used by the ops/daily-report endpoint)
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().default("Quizball Ops <ops@quizball.io>"),
  // Shared secret the scheduled report agent presents to POST the daily report.
  OPS_REPORT_TOKEN: z.string().optional(),
});

type ConfigSchema = z.infer<typeof configSchema>;

export interface Config extends Omit<ConfigSchema, "DOCS_ENABLED"> {
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
      { fieldErrors },
    );
  }

  // REGRESSION_* harness flags pin question randomness / collapse matchmaking
  // delays for the test harness. They MUST never run outside local — in
  // staging/prod they would change real gameplay (deterministic questions, near-
  // instant matchmaking). Checked first so a misconfiguration fails boot fast.
  const regressionFlag =
    (["REGRESSION_DETERMINISTIC", "REGRESSION_FAST_TIMERS"] as const).find(
      (k) => env[k] === "1" || env[k] === "true",
    );
  if (regressionFlag && result.data.NODE_ENV !== "local") {
    throw new ConfigError(
      `Invalid configuration: ${regressionFlag} may only be set in the local environment (it is a regression-harness-only flag).`,
      { nodeEnv: result.data.NODE_ENV, flag: regressionFlag },
    );
  }

  // Auto-disable docs in production unless explicitly enabled
  // Parse DOCS_ENABLED: true/1 = enabled, false/0 = disabled, undefined = auto (enabled except prod)
  const docsEnabled =
    result.data.DOCS_ENABLED === undefined
      ? result.data.NODE_ENV !== "prod"
      : result.data.DOCS_ENABLED === "true" || result.data.DOCS_ENABLED === "1";

  if (docsEnabled && result.data.NODE_ENV !== "local") {
    const hasDocsUsername = !!result.data.DOCS_USERNAME?.trim();
    const hasDocsPassword = !!result.data.DOCS_PASSWORD?.trim();
    if (!hasDocsUsername || !hasDocsPassword) {
      throw new ConfigError(
        "Invalid configuration: DOCS_USERNAME and DOCS_PASSWORD are required when DOCS_ENABLED is true outside local environment.",
        {
          docsEnabled,
          nodeEnv: result.data.NODE_ENV,
          hasDocsUsername,
          hasDocsPassword,
        },
      );
    }
  }

  // The SMS hook/status endpoints fail open (skip auth) when the secret is
  // unset, which is acceptable only locally. Require it outside local so the
  // server refuses to boot with unauthenticated SMS endpoints in staging/prod.
  if (result.data.NODE_ENV !== "local" && !result.data.SUPABASE_SMS_HOOK_SECRET?.trim()) {
    throw new ConfigError(
      "Invalid configuration: SUPABASE_SMS_HOOK_SECRET is required outside local environment.",
      { nodeEnv: result.data.NODE_ENV },
    );
  }

  const hasAnyStripeConfig = Boolean(
    result.data.STRIPE_SECRET_KEY ||
    result.data.STRIPE_WEBHOOK_SECRET ||
    result.data.STRIPE_SUCCESS_URL ||
    result.data.STRIPE_CANCEL_URL,
  );

  if (hasAnyStripeConfig) {
    const requiredStripeVars = [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_SUCCESS_URL",
      "STRIPE_CANCEL_URL",
    ] as const;

    const missing = requiredStripeVars.filter((name) => {
      const value = result.data[name];
      return typeof value !== "string" || value.trim() === "";
    });

    if (missing.length > 0) {
      throw new ConfigError(
        `Invalid configuration: missing required Stripe vars: ${missing.join(", ")}`,
        { missing },
      );
    }
  }

  const hasAnyLokiConfig = Boolean(
    result.data.GRAFANA_LOKI_URL ||
    result.data.GRAFANA_LOKI_USER ||
    result.data.GRAFANA_LOKI_API_KEY,
  );

  if (hasAnyLokiConfig) {
    const requiredLokiVars = [
      "GRAFANA_LOKI_URL",
      "GRAFANA_LOKI_USER",
      "GRAFANA_LOKI_API_KEY",
    ] as const;

    const missing = requiredLokiVars.filter((name) => {
      const value = result.data[name];
      return typeof value !== "string" || value.trim() === "";
    });

    if (missing.length > 0) {
      throw new ConfigError(
        `Invalid configuration: missing required Grafana Loki vars: ${missing.join(", ")}`,
        { missing },
      );
    }
  }

  return {
    ...result.data,
    DOCS_ENABLED: docsEnabled,
  };
}

export const config = parseConfig(process.env);
