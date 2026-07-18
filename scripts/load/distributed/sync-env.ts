/* eslint-disable no-console */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const STAGING_REF = 'nsdfiprfmhdqhbfxfwpv';
const PROD_REF = 'lfbwhxvwubzeqkztghok';
const CAMPAIGN_ID = process.env.CAMPAIGN_ID ?? 'quizball-staging-5k';
const HCLOUD_CONTEXT = process.env.HCLOUD_CONTEXT ?? 'quizball-load';
const SSH_KEY_PATH = process.env.HCLOUD_SSH_KEY_PATH
  ?? join(homedir(), '.ssh', 'quizball-staging-load');

function value(argv: string[], key: string): string | undefined {
  const exact = argv.indexOf(`--${key}`);
  if (exact >= 0) return argv[exact + 1]?.startsWith('--') ? undefined : argv[exact + 1];
  const prefix = `--${key}=`;
  return argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function shellQuote(raw: string): string {
  return `'${raw.replaceAll("'", `'"'"'`)}'`;
}

function required(name: string): string {
  const found = process.env[name];
  if (!found) throw new Error(`${name} is missing from the explicitly selected Railway staging environment.`);
  return found;
}

function stagingEnvironment(): Record<string, string> {
  const supabaseUrl = required('SUPABASE_URL');
  const databaseUrl = required('DATABASE_URL');
  const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const bypassToken = required('CHAOS_BYPASS_TOKEN');
  const combined = `${supabaseUrl} ${databaseUrl}`;
  if (!supabaseUrl.includes(STAGING_REF) || !databaseUrl.includes(STAGING_REF)) {
    throw new Error('PROD GUARD: Railway variables do not both identify QuizBall staging Supabase.');
  }
  if (combined.includes(PROD_REF) || combined.includes('api.quizball.io')) {
    throw new Error('PROD GUARD: production identifier found in proposed worker environment.');
  }
  return {
    TARGET: 'staging',
    API_BASE: 'https://api-staging.quizball.io',
    API_BASE_URL: 'https://api-staging.quizball.io',
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    DATABASE_URL: databaseUrl,
    CHAOS_BYPASS_TOKEN: bypassToken,
    TEST_PASSWORD: process.env.LOAD_TEST_PASSWORD ?? 'ChaosTest12345!',
  };
}

function workerIps(role: string): string[] {
  if (!['mixed', 'auth', 'all'].includes(role)) throw new Error('--fleet must be mixed, auth, or all.');
  const selector = role === 'all'
    ? `quizball-load=true,campaign=${CAMPAIGN_ID}`
    : `quizball-load=true,campaign=${CAMPAIGN_ID},fleet=${role}`;
  const raw = execFileSync('hcloud', [
    '--context', HCLOUD_CONTEXT,
    'server', 'list', '--selector', selector, '-o', 'json',
  ], { encoding: 'utf8' });
  const servers = JSON.parse(raw) as Array<{
    status?: string;
    public_net?: { ipv4?: { ip?: string } };
  }>;
  return servers
    .filter((server) => server.status !== 'deleting')
    .map((server) => server.public_net?.ipv4?.ip ?? '')
    .filter(Boolean);
}

function main(): void {
  const role = value(process.argv.slice(2), 'fleet') ?? 'mixed';
  const env = stagingEnvironment();
  const ips = workerIps(role);
  if (ips.length === 0) throw new Error(`No ${role} load workers found.`);

  const directory = mkdtempSync(join(tmpdir(), 'quizball-load-env-'));
  const envPath = join(directory, 'staging.env');
  try {
    const contents = Object.entries(env)
      .map(([name, raw]) => `${name}=${shellQuote(raw)}`)
      .join('\n') + '\n';
    writeFileSync(envPath, contents, { mode: 0o600 });
    chmodSync(envPath, 0o600);
    for (const ip of ips) {
      execFileSync('scp', [
        '-i', SSH_KEY_PATH,
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new',
        envPath,
        `root@${ip}:/opt/quizball-load/staging.env`,
      ], { stdio: 'ignore' });
      execFileSync('ssh', [
        '-i', SSH_KEY_PATH,
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new',
        `root@${ip}`,
        'chmod 600 /opt/quizball-load/staging.env && chown root:root /opt/quizball-load/staging.env',
      ], { stdio: 'ignore' });
      console.log(`${ip}: staging-only environment installed`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main();
