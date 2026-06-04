/**
 * Self-contained staging test-user bootstrap.
 *
 * Creates (idempotently) two PRE-CONFIRMED test users directly via the Supabase
 * admin API (service-role key → email_confirm:true, no email click), then logs
 * each in for a real access_token (the JWT the socket handshake needs). This means
 * the staging harness needs NO manually-supplied tokens — just the staging Supabase
 * URL + service-role key (read from env, never committed).
 *
 * Required env (provided out-of-band, e.g. from the staging Railway vars):
 *   STAGING_SUPABASE_URL              e.g. https://<ref>.supabase.co
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY service-role JWT (admin)
 * Optional:
 *   STAGING_TEST_EMAIL_A / _B         override the test-user emails
 *   STAGING_TEST_PASSWORD             shared password (default generated-stable)
 */

const SUPABASE_URL = process.env.STAGING_SUPABASE_URL;
const SERVICE_ROLE = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.STAGING_TEST_PASSWORD ?? 'Harness!Test_2026_stable';
// Fresh users per RUN (via STAGING_RUN_TAG) avoid accumulated stale realtime state
// (a crashed run can wedge a reused user in Redis: "already in an active match" /
// instant-forfeit-on-queue). Each run gets clean accounts; clean them up after.
const RUN_TAG = process.env.STAGING_RUN_TAG ?? 'stable';
const EMAIL_A = process.env.STAGING_TEST_EMAIL_A ?? `quizball-harness-${RUN_TAG}-a@quizball.io`;
const EMAIL_B = process.env.STAGING_TEST_EMAIL_B ?? `quizball-harness-${RUN_TAG}-b@quizball.io`;

export interface TestUser {
  email: string;
  userId: string;
  accessToken: string;
}

function requireEnv(): { url: string; key: string } {
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new Error(
      'STAGING_SUPABASE_URL and STAGING_SUPABASE_SERVICE_ROLE_KEY are required (read from staging env, never commit them).',
    );
  }
  return { url: SUPABASE_URL.replace(/\/$/, ''), key: SERVICE_ROLE };
}

/** Create a pre-confirmed user (idempotent — ignores "already registered"). */
async function ensureUser(email: string): Promise<void> {
  const { url, key } = requireEnv();
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  // 422 / "already been registered" → fine, the user exists; ensure password is set.
  if (res.status === 422 || /already.*registered|already exists|email_exists/i.test(body)) {
    await resetPassword(email);
    return;
  }
  throw new Error(`admin createUser failed for ${email}: ${res.status} ${body.slice(0, 300)}`);
}

/** Look up a user id by email + force the password (so login is deterministic). */
async function resetPassword(email: string): Promise<void> {
  const { url, key } = requireEnv();
  const list = await fetch(`${url}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!list.ok) throw new Error(`admin list users failed: ${list.status}`);
  const data = (await list.json()) as { users?: Array<{ id: string; email?: string }> };
  const found = data.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!found) throw new Error(`user ${email} exists but was not found in admin list`);
  const upd = await fetch(`${url}/auth/v1/admin/users/${found.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ password: PASSWORD, email_confirm: true }),
  });
  if (!upd.ok) throw new Error(`admin update user failed for ${email}: ${upd.status}`);
}

/** Log in (password grant) → access_token + user id. */
async function login(email: string): Promise<TestUser> {
  const { url, key } = requireEnv();
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`login failed for ${email}: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token?: string; user?: { id?: string } };
  if (!data.access_token || !data.user?.id) {
    throw new Error(`login for ${email} returned no access_token/user id`);
  }
  return { email, userId: data.user.id, accessToken: data.access_token };
}

/** Ensure both test users exist (confirmed) and return their tokens. */
export async function bootstrapTestUsers(): Promise<{ a: TestUser; b: TestUser }> {
  await ensureUser(EMAIL_A);
  await ensureUser(EMAIL_B);
  const [a, b] = await Promise.all([login(EMAIL_A), login(EMAIL_B)]);
  return { a, b };
}

/** Delete the run's test users (best-effort) so per-run accounts don't pile up. */
export async function deleteTestUsers(users: { a: TestUser; b: TestUser }): Promise<void> {
  const { url, key } = requireEnv();
  for (const u of [users.a, users.b]) {
    try {
      await fetch(`${url}/auth/v1/admin/users/${u.userId}`, {
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
    } catch { /* best-effort cleanup */ }
  }
}
