/**
 * The one target check of the content scripts that write to staging. The connection's host (direct) or its pooler user
 * must name the staging project, and the production ref may appear nowhere in the URL: a staging ref found only in a
 * password or a query string is not enough.
 */
export const STAGING_REF = 'nsdfiprfmhdqhbfxfwpv';
export const PROD_REF = 'lfbwhxvwubzeqkztghok';

export type Target = 'staging' | 'local';

export function stagingTarget(url: string, options: { allowLocal?: boolean } = {}): Target {
  let host = '';
  let user = '';
  let params: string[] = [];
  let decoded = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    user = decodeURIComponent(parsed.username);
    params = [...parsed.searchParams.keys()];
    decoded = decodeURIComponent(url).toLowerCase();
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (decoded.includes(PROD_REF)) throw new Error(`DATABASE_URL names the production project ${PROD_REF}`);
  // A query parameter can override the user, host or database the driver connects with: only TLS mode is allowed.
  const unexpected = params.filter((p) => p !== 'sslmode');
  if (unexpected.length > 0) throw new Error(`DATABASE_URL may not carry connection parameters (${unexpected.join(', ')})`);
  if (options.allowLocal && (host === '127.0.0.1' || host === 'localhost')) return 'local';
  const direct = host === `db.${STAGING_REF}.supabase.co`;
  const pooler = host.endsWith('.pooler.supabase.com') && user === `postgres.${STAGING_REF}`;
  if (!direct && !pooler) throw new Error(`DATABASE_URL must target the staging project ${STAGING_REF} (its host, or its pooler user)`);
  return 'staging';
}

/** As `stagingTarget`, printing the reason and exiting instead of throwing (for a script's top level). */
export function requireStagingTarget(url: string, options: { allowLocal?: boolean } = {}): Target {
  try {
    return stagingTarget(url, options);
  } catch (error) {
    console.error(`ABORT: ${(error as Error).message}`);
    process.exit(1);
  }
}

/** postgres.js options for the transaction pooler: it can hand each statement to another backend, so nothing is prepared. */
export const POOLER_SAFE = { prepare: false } as const;
