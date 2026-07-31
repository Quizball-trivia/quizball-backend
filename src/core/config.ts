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
  // Per-process budget. With two Railway replicas the default permits at most
  // 24 app connections, leaving headroom below the small-tier Postgres limit
  // for Auth, Storage, PostgREST, Realtime, observability, and administration.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(30).default(12),
  DB_INFLIGHT_LIMIT: z.coerce.number().int().min(1).max(30).default(12),
  // Keep this finite so a database outage still sheds instead of accumulating
  // unbounded promises. Streamer-scale bursts can safely need more than 100
  // waiters while millisecond queries drain; the acquire deadline remains the
  // hard time bound.
  DB_QUEUE_LIMIT: z.coerce.number().int().min(0).max(1_000).default(12),
  DB_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(1500),
  DB_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(60).max(7200).default(1800),
  DB_WATCHDOG_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("true")
    .transform((val) => val !== "false" && val !== "0"),
  DB_WATCHDOG_INTERVAL_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  DB_WATCHDOG_TIMEOUT_MS: z.coerce.number().int().min(500).max(15_000).default(4_000),
  DB_WATCHDOG_FAILURES: z.coerce.number().int().min(1).max(10).default(3),
  // INC-2026-07-29: a pooled connection contaminated with
  // default_transaction_read_only=on let reads succeed while every write failed
  // with SQLSTATE 25006. Kill switch in case the breaker ever misfires.
  DB_OUTAGE_BREAKER_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("true")
    .transform((val) => val !== "false" && val !== "0"),
  // Minimum time to stay degraded after a 25006. Recovery additionally requires
  // a successful rollback-only write probe, so this is a floor, not a timer.
  DB_OUTAGE_BREAKER_WINDOW_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),

  // Redis
  REDIS_URL: z.string().url().optional(),
  // Maximum durable realtime timers handled concurrently by each replica.
  // Keep the default conservative for small/local pools; large synchronized
  // gameplay starts can raise this explicitly after sizing the DB bulkhead.
  REALTIME_TIMER_HANDLER_CONCURRENCY: z.coerce.number().int().min(1).max(30).default(4),
  // Optional safety bound for penalty shootouts. Zero preserves the current
  // unlimited sudden-death behavior; staging can validate a finite bound
  // before any production gameplay-policy decision is made.
  POSSESSION_MAX_SUDDEN_DEATH_ROUNDS: z.coerce.number().int().min(0).max(20).default(0),
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
  RANKED_DEBUG_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  // When false, objectives stop progressing and stop awarding coins/XP after
  // matches (paired with hiding the Objectives UI behind the frontend flag).
  OBJECTIVES_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("true")
    .transform((val) => val !== "false" && val !== "0"),
  // Persistent-bot question_stats refresh job. Ships DISABLED: no scheduler is
  // wired to it in this PR. When a later PR adds a worker/pg_cron trigger, it
  // must gate on this flag. The manual `npm run bot:refresh-question-stats`
  // entrypoint runs regardless (it is invoked by a human, not the scheduler).
  QUESTION_STATS_REFRESH_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  // Persistent-bot live selection kill switch. Ships DISABLED (PR7). When OFF
  // the ranked AI-fallback path is byte-identical to today: an ephemeral bot is
  // created per match, no reservation row is ever touched. When ON, an eligible
  // roster bot is reserved and used where one exists; an empty roster or an
  // exhausted eligibility ladder always falls back to the ephemeral path, so
  // matchmaking never fails. Read at selection time (config reflects the
  // deployed env — flipping it is an env change, like every other flag here).
  PERSISTENT_BOTS_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  // Rubber-band governor kill switch (PR9). Ships ENABLED, unlike the flags
  // above, because it is a SAFETY loop, not a feature: it is what keeps roster
  // bots from climbing into the human top 10 and what steers win rate into the
  // 40-45% / 45-55% bands. It is inert while PERSISTENT_BOTS_ENABLED is off
  // (no persistent bot settles a match, so the governor is never invoked), so
  // defaulting ON adds no behavior until the roster actually ships.
  //
  // Turning it OFF zeroes the offset at PIN time (so every match created after
  // the flip runs on base calibrated skill) and additionally drives the stored
  // value to 0 at each bot's next settlement.
  //
  // Two residual windows it does NOT close, by construction:
  //   - a match ALREADY IN FLIGHT keeps the adjustment pinned into its
  //     ranked_context (that immutability is the §1.7 invariant — a live match
  //     must not change under the players);
  //   - during a ROLLING deploy, replicas still running the previous release
  //     read the stored offset directly and cannot honour the new flag.
  // Both drain within one match / one deploy. For an immediate, global stop,
  // zero the column: UPDATE synthetic_player_profiles SET governor_adjustment=0.
  // Base calibrated skill is still bound by the Layer-1 hard clamps either way,
  // so neither window is a safety hole — only a delay in the trim.
  BOT_GOVERNOR_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("true")
    .transform((val) => val !== "false" && val !== "0"),

  // Supabase
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  // Modern server-only API key (sb_secret_...). Required only when hosted
  // Supabase Auth IP forwarding is explicitly enabled.
  SUPABASE_SECRET_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_AUTH_IP_FORWARDING_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  // Per-process bulkhead for hosted Auth, whose DB connections are outside the
  // application pool. With two replicas the default permits eight concurrent
  // upstream Auth operations while preserving the shared 60-connection tier.
  AUTH_INFLIGHT_LIMIT: z.coerce.number().int().min(1).max(30).default(4),
  AUTH_QUEUE_LIMIT: z.coerce.number().int().min(0).max(1000).default(16),
  AUTH_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2000),
  AUTH_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(10_000),
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

  // Load-testing rate-limit bypass. When set (NON-PROD ONLY), a request whose
  // `x-chaos-bypass` header matches this secret skips the API rate limiter so
  // the chaos harness can drive real RPS. Hard-disabled when NODE_ENV==='prod'.
  CHAOS_BYPASS_TOKEN: z.string().optional(),
  // Weekend League ops controls (pause/resume/cancel/test tournaments).
  // Unset = the WL ops surface is disabled entirely (404).
  WL_OPS_TOKEN: z.string().optional(),
  // Master switch for WL orchestration: weekly REAL tournament creation and
  // reconciler ticks. Default OFF — test tournaments via the ops API still
  // work when the orchestrator loop is started manually (force-tick), so
  // staging can exercise the flow before launch without auto-creating real
  // Saturday events that the stub engine would farce-complete.
  WL_ORCHESTRATION_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .pipe(z.boolean())
    .optional()
    .default('false'),

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
  // Where player contact/feedback submissions are emailed.
  FEEDBACK_RECIPIENT_EMAIL: z.string().email().default("nika@quizball.io"),
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

  if (result.data.REALTIME_TIMER_HANDLER_CONCURRENCY > result.data.DB_INFLIGHT_LIMIT) {
    throw new ConfigError(
      "Invalid configuration: REALTIME_TIMER_HANDLER_CONCURRENCY cannot exceed DB_INFLIGHT_LIMIT.",
      {
        realtimeTimerHandlerConcurrency: result.data.REALTIME_TIMER_HANDLER_CONCURRENCY,
        dbInflightLimit: result.data.DB_INFLIGHT_LIMIT,
      },
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

  if (result.data.SUPABASE_AUTH_IP_FORWARDING_ENABLED) {
    const secretKey = result.data.SUPABASE_SECRET_KEY?.trim();
    if (!secretKey?.startsWith("sb_secret_")) {
      throw new ConfigError(
        "Invalid configuration: SUPABASE_AUTH_IP_FORWARDING_ENABLED requires a modern SUPABASE_SECRET_KEY beginning with sb_secret_.",
        {
          nodeEnv: result.data.NODE_ENV,
          hasSecretKey: Boolean(secretKey),
        },
      );
    }
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
