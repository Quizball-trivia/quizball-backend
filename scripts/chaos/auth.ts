// Provisions a fleet of pre-confirmed test users on a NON-PROD Supabase project
// (via the admin API), logs each in against the app, and returns bearer tokens.
// Self-contained: registers/creates idempotently, so re-runs reuse the same
// users. Never run against prod — guarded by the caller.

export interface ChaosUser {
  email: string;
  password: string;
  userId: string;
  token: string;
}

interface ProvisionConfig {
  apiBase: string; // e.g. https://api-staging.quizball.io
  supabaseUrl: string; // e.g. https://nsdfiprfmhdqhbfxfwpv.supabase.co
  serviceRoleKey: string;
  count: number;
  password: string;
  emailPrefix: string; // e.g. "chaos" → chaos+u0@quizball.io
  emailDomain: string; // e.g. quizball.io
  concurrency: number;
}

async function adminCreateConfirmedUser(
  cfg: ProvisionConfig,
  email: string
): Promise<void> {
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password: cfg.password, email_confirm: true }),
  });
  if (res.status === 200 || res.status === 201) return;
  // 422 = already registered → reuse it (idempotent).
  if (res.status === 422) return;
  const text = await res.text();
  throw new Error(`admin create user ${email} failed: ${res.status} ${text.slice(0, 200)}`);
}

async function login(
  cfg: ProvisionConfig,
  email: string
): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${cfg.apiBase}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: cfg.password }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    user?: { provider_sub?: string };
  };
  if (!res.ok || !body.access_token) {
    throw new Error(`login ${email} failed: ${res.status}`);
  }
  // Resolve the internal user id via /users/me (provider_sub is the supabase id,
  // not the app's internal id used in route params).
  const meRes = await fetch(`${cfg.apiBase}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${body.access_token}` },
  });
  const me = (await meRes.json().catch(() => ({}))) as { id?: string };
  return { token: body.access_token, userId: me.id ?? '' };
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
  const emails = Array.from(
    { length: cfg.count },
    (_, i) => `${cfg.emailPrefix}+u${i}@${cfg.emailDomain}`
  );

  // Create (idempotent) then log in, both bounded by concurrency.
  await mapWithConcurrency(emails, cfg.concurrency, (email) =>
    adminCreateConfirmedUser(cfg, email)
  );

  const users = await mapWithConcurrency(emails, cfg.concurrency, async (email) => {
    const { token, userId } = await login(cfg, email);
    return { email, password: cfg.password, token, userId } satisfies ChaosUser;
  });

  return users.filter((u) => u.token && u.userId);
}
