// Provisions a fleet of pre-confirmed test users on a NON-PROD Supabase project
// (via the admin API), logs each in against the app, and returns bearer tokens.
// Self-contained: registers/creates idempotently, so re-runs reuse the same
// users. Never run against prod — guarded by the caller.

import postgres from 'postgres';

export interface ChaosUser {
  email: string;
  password: string;
  userId: string;
  token: string;
}

export interface ProvisionConfig {
  apiBase: string; // e.g. https://api-staging.quizball.io
  supabaseUrl: string; // e.g. https://nsdfiprfmhdqhbfxfwpv.supabase.co
  serviceRoleKey: string;
  count: number;
  /** First numeric user suffix, used to give distributed workers disjoint shards. */
  startIndex?: number;
  password: string;
  emailPrefix: string; // e.g. "chaos" → chaos+u0@quizball.io
  emailDomain: string; // e.g. quizball.io
  concurrency: number;
  /**
   * Minimum spacing between password-login requests made by this generator.
   * Supabase Auth limits /token by source IP, so a single staging load runner
   * must pace session bootstrap even though real users arrive from many IPs.
   */
  loginIntervalMs?: number;
  bypassToken?: string;
}

export class ChaosLoginError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable = status === 429 || status >= 500
  ) {
    super(message);
    this.name = 'ChaosLoginError';
  }
}

export interface TicketTopUpConfig {
  target: 'staging' | 'local';
  apiBase: string;
  supabaseUrl: string;
  databaseUrl: string;
  userIds: string[];
  tickets: number;
}

export interface CoinPurchaseFixtureConfig {
  target: 'staging' | 'local';
  apiBase: string;
  supabaseUrl: string;
  databaseUrl: string;
  userIds: string[];
  coins: number;
  productSlug: string;
}

function adminHeaders(cfg: Pick<ProvisionConfig, 'serviceRoleKey'>): Record<string, string> {
  return {
    apikey: cfg.serviceRoleKey,
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

async function adminCreateConfirmedUser(
  cfg: ProvisionConfig,
  email: string
): Promise<void> {
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders(cfg),
    body: JSON.stringify({ email, password: cfg.password, email_confirm: true }),
  });
  if (res.status === 200 || res.status === 201) return;
  const text = await res.text();
  throw new Error(`admin create user ${email} failed: ${res.status} ${text.slice(0, 200)}`);
}

async function listAdminUserIdsByEmail(
  cfg: ProvisionConfig,
  wantedEmails: Set<string>
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const perPage = 1_000;
  // The Auth admin endpoint is paginated. Bound the scan so a broken upstream
  // response cannot make a load-test preparation command loop forever.
  for (let page = 1; page <= 100 && found.size < wantedEmails.size; page += 1) {
    const response = await fetch(
      `${cfg.supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
      { headers: adminHeaders(cfg) }
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`admin list users failed: ${response.status} ${text.slice(0, 200)}`);
    }
    const payload = await response.json() as {
      users?: Array<{ id?: string; email?: string }>;
    };
    const users = payload.users ?? [];
    for (const user of users) {
      const email = user.email?.toLowerCase();
      if (email && user.id && wantedEmails.has(email)) found.set(email, user.id);
    }
    if (users.length < perPage) break;
  }
  return found;
}

async function adminResetConfirmedUser(
  cfg: ProvisionConfig,
  userId: string,
  email: string
): Promise<void> {
  const response = await fetch(`${cfg.supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: adminHeaders(cfg),
    body: JSON.stringify({ password: cfg.password, email_confirm: true }),
  });
  if (response.ok) return;
  const text = await response.text();
  throw new Error(`admin reset user ${email} failed: ${response.status} ${text.slice(0, 200)}`);
}

export async function loginChaosUser(
  cfg: Pick<ProvisionConfig, 'apiBase' | 'password' | 'bypassToken'>,
  email: string
): Promise<{ token: string; userId: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.bypassToken) headers['x-chaos-bypass'] = cfg.bypassToken;
  const res = await fetch(`${cfg.apiBase}/api/v1/auth/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password: cfg.password }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    user?: { provider_sub?: string };
  };
  if (!res.ok || !body.access_token) {
    throw new ChaosLoginError(`login ${email} failed: ${res.status}`, res.status);
  }
  // Resolve the internal user id via /users/me (provider_sub is the supabase id,
  // not the app's internal id used in route params).
  const meRes = await fetch(`${cfg.apiBase}/api/v1/users/me`, {
    headers: {
      Authorization: `Bearer ${body.access_token}`,
      ...(cfg.bypassToken ? { 'x-chaos-bypass': cfg.bypassToken } : {}),
    },
  });
  const me: unknown = await meRes.json().catch(() => null);
  const userId = typeof me === 'object'
    && me !== null
    && 'id' in me
    && typeof me.id === 'string'
    && me.id.trim().length > 0
    ? me.id
    : null;
  if (!meRes.ok || !userId) {
    // A freshly issued token can still hit a transient Auth introspection 5xx
    // (surfaced by the API as 401). Treat that preparation-only condition as
    // retryable; the next attempt obtains a fresh token and verifies it again.
    throw new ChaosLoginError(
      `resolve /users/me for ${email} failed: ${meRes.status}`,
      meRes.status,
      meRes.status === 401 || meRes.status === 429 || meRes.status >= 500
    );
  }
  return { token: body.access_token, userId };
}

function createLoginPacer(intervalMs: number): () => Promise<void> {
  if (intervalMs <= 0) return async () => {};

  let nextAllowedAt = Date.now();
  return async () => {
    const now = Date.now();
    const slot = Math.max(now, nextAllowedAt);
    nextAllowedAt = slot + intervalMs;
    const waitMs = slot - now;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  };
}

function assertTicketTopUpTarget(cfg: TicketTopUpConfig): void {
  const PROD_PROJECT = 'lfbwhxvwubzeqkztghok';
  const blob = `${cfg.apiBase} ${cfg.supabaseUrl} ${cfg.databaseUrl}`;
  if (blob.includes(PROD_PROJECT) || blob.includes('api.quizball.io')) {
    throw new Error('PROD GUARD: refusing direct ticket top-up against production.');
  }
  if (cfg.target === 'staging' && !cfg.supabaseUrl.includes('nsdfiprfmhdqhbfxfwpv')) {
    throw new Error(
      `PROD GUARD: staging ticket top-up expected staging Supabase, got "${cfg.supabaseUrl}".`
    );
  }
  if (cfg.target === 'local' && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(cfg.apiBase)) {
    throw new Error(`PROD GUARD: local socket target must be localhost, got "${cfg.apiBase}".`);
  }
}

function assertDirectFixtureTarget(
  cfg: Pick<CoinPurchaseFixtureConfig, 'target' | 'apiBase' | 'supabaseUrl' | 'databaseUrl'>
): void {
  const PROD_PROJECT = 'lfbwhxvwubzeqkztghok';
  const STAGING_PROJECT = 'nsdfiprfmhdqhbfxfwpv';
  const blob = `${cfg.apiBase} ${cfg.supabaseUrl} ${cfg.databaseUrl}`;
  if (blob.includes(PROD_PROJECT) || blob.includes('api.quizball.io')) {
    throw new Error('PROD GUARD: refusing direct economy fixture setup against production.');
  }
  if (cfg.target === 'staging') {
    if (!cfg.supabaseUrl.includes(STAGING_PROJECT) || !cfg.databaseUrl.includes(STAGING_PROJECT)) {
      throw new Error(
        'PROD GUARD: staging economy setup requires both staging Supabase and database URLs.'
      );
    }
  }
  if (cfg.target === 'local') {
    const localApi = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(cfg.apiBase);
    const localDb = /^postgres(?:ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(cfg.databaseUrl);
    if (!localApi || !localDb) {
      throw new Error('PROD GUARD: local economy setup requires localhost API and database URLs.');
    }
  }
}

export async function ensureTickets(cfg: TicketTopUpConfig): Promise<void> {
  assertTicketTopUpTarget(cfg);
  const userIds = cfg.userIds.filter(Boolean);
  if (userIds.length === 0) return;
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL missing — cannot top up ranked tickets.');
  const tickets = Math.max(0, Math.min(5, Math.floor(cfg.tickets)));
  const sql = postgres(cfg.databaseUrl, { max: 1 });
  try {
    await sql`
      UPDATE users
      SET tickets = GREATEST(tickets, ${tickets}),
          tickets_refill_started_at = CASE
            WHEN GREATEST(tickets, ${tickets}) >= 5 THEN NULL
            ELSE tickets_refill_started_at
          END,
          updated_at = NOW()
      WHERE id IN ${sql(userIds)}
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Reset only synthetic load users so the real coin-purchase transaction can be
 * repeated without carrying state from an earlier run. This deliberately does
 * not call Stripe or modify any account outside the explicitly provisioned
 * non-production shard.
 */
export async function ensureCoinPurchaseFixtures(
  cfg: CoinPurchaseFixtureConfig
): Promise<void> {
  assertDirectFixtureTarget(cfg);
  const userIds = [...new Set(cfg.userIds.filter(Boolean))];
  if (userIds.length === 0) return;
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL missing — cannot prepare economy fixtures.');
  if (cfg.productSlug !== 'chance_card_5050') {
    throw new Error(`Economy load fixture only permits chance_card_5050, got "${cfg.productSlug}".`);
  }
  const coins = Math.max(0, Math.min(100_000, Math.floor(cfg.coins)));
  const sql = postgres(cfg.databaseUrl, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      const [product] = await tx<Array<{ id: string }>>`
        SELECT id
        FROM store_products
        WHERE slug = ${cfg.productSlug}
          AND is_active = true
        LIMIT 1
      `;
      if (!product) throw new Error(`Required store product ${cfg.productSlug} is unavailable.`);

      // Remove load-generated audit rows before their purchases so the audit
      // FK never points at a deleted synthetic purchase.
      await tx`
        DELETE FROM store_transaction_logs
        WHERE user_id IN ${tx(userIds)}
          AND reason = 'coin_purchase'
          AND product_id = ${product.id}
      `;
      await tx`
        DELETE FROM store_purchases
        WHERE user_id IN ${tx(userIds)}
          AND product_id = ${product.id}
          AND currency = 'coins'
      `;
      await tx`
        DELETE FROM user_inventory
        WHERE user_id IN ${tx(userIds)}
          AND product_id = ${product.id}
      `;
      await tx`
        UPDATE users
        SET coins = GREATEST(coins, ${coins}),
            updated_at = NOW()
        WHERE id IN ${tx(userIds)}
      `;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function provisionUsers(cfg: ProvisionConfig): Promise<ChaosUser[]> {
  const emails = await ensureChaosUsers(cfg);
  const waitForLoginSlot = createLoginPacer(cfg.loginIntervalMs ?? 0);

  const users = await mapWithConcurrency(emails, cfg.concurrency, async (email) => {
    // Keep source-IP throttling and transient Auth 5xx/introspection failures
    // in preparation traffic out of the measured run. Credential/schema
    // failures remain immediate hard failures.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await waitForLoginSlot();
      try {
        const { token, userId } = await loginChaosUser(cfg, email);
        return { email, password: cfg.password, token, userId } satisfies ChaosUser;
      } catch (error) {
        if (!(error instanceof ChaosLoginError) || !error.retryable || attempt === 4) {
          throw error;
        }
        const backoffMs = 100 * (2 ** attempt) + Math.floor(Math.random() * 100);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    throw new Error(`login ${email} exhausted retries`);
  });

  return users.filter((u) => u.token && u.userId);
}

/**
 * Idempotently create confirmed non-production load users without logging them
 * in. Large k6 runs call this once ahead of time so provisioning traffic is not
 * mixed into the measured login/refresh/API workload.
 */
export async function ensureChaosUsers(cfg: ProvisionConfig): Promise<string[]> {
  const emails = Array.from(
    { length: cfg.count },
    (_, i) => `${cfg.emailPrefix}+u${(cfg.startIndex ?? 0) + i}@${cfg.emailDomain}`
  );

  // Existing test accounts may have been created by an older harness with a
  // different password. Merely accepting Auth's 422 "already registered"
  // response makes the next login fail nondeterministically, so make the
  // desired credentials genuinely idempotent before measuring any traffic.
  const wanted = new Set(emails.map((email) => email.toLowerCase()));
  const existing = await listAdminUserIdsByEmail(cfg, wanted);
  await mapWithConcurrency(emails, cfg.concurrency, async (email) => {
    const existingId = existing.get(email.toLowerCase());
    if (existingId) {
      await adminResetConfirmedUser(cfg, existingId, email);
      return;
    }
    await adminCreateConfirmedUser(cfg, email);
  });
  return emails;
}
