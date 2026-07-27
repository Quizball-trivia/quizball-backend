/**
 * Guards burn-in/rollback scripts against silently targeting a remote DB.
 *
 * An incident occurred where cleanup DELETEs hit staging because a bare
 * `loadEnv()` call (loading `.env`) overrode `.env.local`'s localhost DSN
 * with the staging pooler DSN. This guard makes the resolved DB host an
 * explicit, checked precondition instead of an implicit side effect of
 * dotenv load order.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const MANAGED_POOLER_SUBSTRINGS = ['pooler.supabase.com', '.supabase.co'];

function parseHost(dsn: string): string {
  try {
    return new URL(dsn).hostname;
  } catch {
    throw new Error(`Refusing to run burn-in: could not parse DB host from DSN '${dsn}'.`);
  }
}

export function assertDbTarget(dsn: string, opts: { allowRemote: boolean }): void {
  const host = parseHost(dsn);
  const isLocal = LOCAL_HOSTS.has(host);
  const isManagedPooler = MANAGED_POOLER_SUBSTRINGS.some((substr) => dsn.includes(substr));

  if (!isLocal && !opts.allowRemote) {
    throw new Error(
      `Refusing to run burn-in against non-local DB host '${host}'. Pass --allow-remote to target a deliberate remote environment.`,
    );
  }

  if (isManagedPooler) {
    const confirmEnv = process.env.BURNIN_CONFIRM_ENV ?? '';
    if (confirmEnv.trim() === '') {
      throw new Error(
        `Refusing to run burn-in against managed-pooler DB host '${host}'. Set BURNIN_CONFIRM_ENV=<environment name> to explicitly acknowledge the target environment.`,
      );
    }
  }
}
