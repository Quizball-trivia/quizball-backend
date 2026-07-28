/**
 * Guards burn-in/rollback scripts against silently targeting the wrong DB.
 *
 * An incident occurred where cleanup DELETEs hit staging because a bare
 * `loadEnv()` call (loading `.env`) overrode `.env.local`'s localhost DSN with
 * the staging pooler DSN. This guard makes the resolved DB target an explicit,
 * checked precondition instead of an implicit side effect of dotenv load order.
 *
 * Rules:
 *   - localhost / 127.0.0.1 → allowed without confirmation.
 *   - any non-local host → requires --allow-remote AND a BURNIN_CONFIRM_ENV that
 *     MATCHES the target's identity (not merely nonempty):
 *       * Supabase (host contains 'supabase.co'/'pooler.supabase.com', case-
 *         insensitive) → identity = the project ref (e.g. the user
 *         'postgres.<ref>' or the '<ref>.supabase.co' subdomain).
 *       * any other remote → identity = the hostname.
 *     Confirmation is compared case-insensitively.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

interface TargetIdentity {
  host: string;
  isLocal: boolean;
  isSupabase: boolean;
  /** The value BURNIN_CONFIRM_ENV must match (project ref, or hostname). */
  confirmToken: string;
}

export function resolveTarget(dsn: string): TargetIdentity {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(`Refusing to run burn-in: could not parse DB DSN.`);
  }
  const host = url.hostname.toLowerCase();
  const isLocal = LOCAL_HOSTS.has(host);
  const isSupabase = host.includes('supabase.co') || host.includes('pooler.supabase.com');

  // Supabase project ref (P2-2):
  //   - pooler:  user is 'postgres.<ref>'  (host = *.pooler.supabase.com)
  //   - direct:  host is 'db.<ref>.supabase.co' → the ref is the label AFTER 'db.'
  //     (host.split('.')[0] is 'db', NOT the ref).
  let confirmToken = host;
  if (isSupabase) {
    const user = decodeURIComponent(url.username);
    const userRef = user.startsWith('postgres.') ? user.slice('postgres.'.length) : '';
    let sub = '';
    if (host.endsWith('.supabase.co')) {
      const labels = host.split('.'); // e.g. ['db','<ref>','supabase','co'] or ['<ref>','supabase','co']
      sub = labels[0] === 'db' && labels.length >= 4 ? labels[1] : labels[0];
    }
    confirmToken = (userRef || sub || host).toLowerCase();
  }
  return { host, isLocal, isSupabase, confirmToken };
}

export function assertDbTarget(dsn: string, opts: { allowRemote: boolean }): void {
  const t = resolveTarget(dsn);
  if (t.isLocal) return;

  if (!opts.allowRemote) {
    throw new Error(
      `Refusing to run burn-in against non-local DB host '${t.host}'. Pass --allow-remote to target a deliberate remote environment.`,
    );
  }

  const confirm = (process.env.BURNIN_CONFIRM_ENV ?? '').trim().toLowerCase();
  if (confirm === '') {
    throw new Error(
      `Refusing to run burn-in against remote host '${t.host}'. Set BURNIN_CONFIRM_ENV to the target identity ('${t.confirmToken}') to explicitly acknowledge it.`,
    );
  }
  if (confirm !== t.confirmToken) {
    throw new Error(
      `BURNIN_CONFIRM_ENV='${confirm}' does not match the target identity '${t.confirmToken}' (host '${t.host}'). Refusing — this prevents pointing a confirmation for one environment at another.`,
    );
  }
}
