/**
 * Connection options for the partner core DB tests, built only from validated fields: postgres.js never sees the raw
 * URL, so a multihost authority or a query parameter (`?host=`, `?database=`) cannot redirect it.
 */
export interface TestDbOptions {
  host: '127.0.0.1' | '::1';
  port: number;
  user: string;
  password: string;
  database: string;
}

const LOOPBACK: Record<string, TestDbOptions['host']> = { '127.0.0.1': '127.0.0.1', localhost: '127.0.0.1', '[::1]': '::1' };

export function testDbOptions(raw: string, databasePattern: RegExp): TestDbOptions {
  const match = /^postgres(?:ql)?:\/\/([^/?#]*)(\/[^?#]*)?([?#].*)?$/.exec(raw);
  if (!match) throw new Error('test database URL is not a postgresql:// URL');
  const [, authority, path = '', rest] = match;
  if (rest) throw new Error('test database URL must not carry query parameters or a fragment');
  if (authority!.includes(',') || (authority!.match(/@/g)?.length ?? 0) > 1) {
    throw new Error('test database URL must name exactly one host');
  }
  const u = new URL(raw);
  const host = LOOPBACK[u.hostname];
  if (!host) throw new Error('test database must be on this machine (127.0.0.1 or ::1)');
  if (!/^\d{1,5}$/.test(u.port || '5432')) throw new Error('test database port must be numeric');
  const port = Number(u.port || '5432');
  if (port < 1 || port > 65535) throw new Error('test database port is out of range');
  const database = decodeURIComponent(path.replace(/^\//, ''));
  if (!databasePattern.test(database)) throw new Error(`test database name must match ${databasePattern}`);
  if (!u.username) throw new Error('test database URL must name a user');
  return {
    host,
    port,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
  };
}

/** An existing isolated database the tests may wipe. */
export const ISOLATED_DATABASE = /^quizball_partner_test_[a-z0-9_]+$/;
/** CI's admin connection (a database the tests only CREATE/DROP from, never write to). */
export const ADMIN_DATABASE = /^[a-z_][a-z0-9_]{0,62}$/;
