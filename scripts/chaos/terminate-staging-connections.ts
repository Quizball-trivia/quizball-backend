/* eslint-disable no-console */
import postgres from 'postgres';

const STAGING_PROJECT_REF = 'nsdfiprfmhdqhbfxfwpv';
const PROD_PROJECT_REF = 'lfbwhxvwubzeqkztghok';
const EXPECTED_STAGING_MAX_CONNECTIONS = 60;

function value(argv: string[], key: string): string | undefined {
  const exact = argv.indexOf(`--${key}`);
  if (exact >= 0) return argv[exact + 1]?.startsWith('--') ? 'true' : argv[exact + 1] ?? 'true';
  const prefix = `--${key}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function assertStagingDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const pointsAtStaging = databaseUrl.includes(STAGING_PROJECT_REF);
  const pointsAtProd = databaseUrl.includes(PROD_PROJECT_REF);
  if (!pointsAtStaging || pointsAtProd) {
    throw new Error('Refusing connection termination: DATABASE_URL is not the staging Supabase project.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('Refusing connection termination: DATABASE_URL must use Postgres.');
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = value(argv, 'apply') === 'true';
  const databaseUrl = value(argv, 'db') ?? process.env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  assertStagingDatabase(databaseUrl);

  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    prepare: false,
    onnotice: () => {},
  });

  try {
    const identity = await sql<{
      current_user: string;
      current_database: string;
      max_connections: number;
    }[]>`
      SELECT
        current_user,
        current_database(),
        current_setting('max_connections')::int AS max_connections
    `;
    const current = identity[0];
    if (!current || current.max_connections !== EXPECTED_STAGING_MAX_CONNECTIONS) {
      throw new Error(
        `Refusing connection termination: expected staging max_connections=${EXPECTED_STAGING_MAX_CONNECTIONS}, `
        + `observed ${current?.max_connections ?? 'unknown'}.`
      );
    }

    const candidates = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = current_user
        AND application_name = 'Supavisor'
        AND backend_type = 'client backend'
        AND pid <> pg_backend_pid()
    `;
    const candidateCount = candidates[0]?.count ?? 0;
    console.log(JSON.stringify({
      target: 'staging',
      database: current.current_database,
      user: current.current_user,
      maxConnections: current.max_connections,
      candidatePoolerBackends: candidateCount,
      mode: apply ? 'apply' : 'dry-run',
    }, null, 2));

    if (!apply) {
      console.log('Dry run only. Pass --apply to terminate the listed staging Supavisor backends.');
      return;
    }
    if (candidateCount === 0) {
      throw new Error('No staging Supavisor backend connections were available to terminate.');
    }

    const result = await sql<{ attempted: number; terminated: number }[]>`
      WITH targets AS (
        SELECT pid
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND usename = current_user
          AND application_name = 'Supavisor'
          AND backend_type = 'client backend'
          AND pid <> pg_backend_pid()
      ), terminated AS (
        SELECT pg_terminate_backend(pid) AS ok
        FROM targets
      )
      SELECT
        count(*)::int AS attempted,
        count(*) FILTER (WHERE ok)::int AS terminated
      FROM terminated
    `;
    console.log(JSON.stringify({ result: result[0] ?? { attempted: 0, terminated: 0 } }, null, 2));
  } finally {
    await sql.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
