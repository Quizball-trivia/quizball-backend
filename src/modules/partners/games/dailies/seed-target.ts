/** Connection for the content-pool seeder, built only from validated fields: postgres.js never sees the raw URL, so a
 *  host list (`remote,unused@localhost`), a second `@` or a query parameter (`?host=`) cannot point it somewhere
 *  other than the host the target guard checked. Same rules as tests/partners/test-db.ts. */

export interface SeedConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  local: boolean;
}

const LOOPBACK: Record<string, string> = { '127.0.0.1': '127.0.0.1', localhost: '127.0.0.1', '[::1]': '::1' };

export function parseSeedDatabaseUrl(raw: string | undefined): SeedConnection {
  if (!raw) throw new Error('DATABASE_URL is not set');
  const match = /^postgres(?:ql)?:\/\/([^/?#]*)(\/[^?#]*)?([?#].*)?$/.exec(raw);
  if (!match) throw new Error('DATABASE_URL is not a postgresql:// URL');
  const [, authority, path = '', rest] = match;
  if (rest) throw new Error('DATABASE_URL must not carry query parameters or a fragment');
  if (authority!.includes(',')) throw new Error('DATABASE_URL must name exactly one host');
  if ((authority!.match(/@/g)?.length ?? 0) !== 1) throw new Error('DATABASE_URL must name exactly one user@host');
  const url = new URL(raw);
  if (!/^\d{0,5}$/.test(url.port)) throw new Error('DATABASE_URL port must be numeric');
  const port = Number(url.port || '5432');
  if (port < 1 || port > 65535) throw new Error('DATABASE_URL port is out of range');
  const database = decodeURIComponent(path.replace(/^\//, ''));
  if (!database || database.includes('/')) throw new Error('DATABASE_URL must name one database');
  if (!url.username) throw new Error('DATABASE_URL must name a user');
  const loopback = LOOPBACK[url.hostname];
  return {
    host: loopback ?? url.hostname,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    local: loopback !== undefined,
  };
}
