/* eslint-disable no-console */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureChaosUsers } from '../chaos/auth.js';

interface Args {
  target: 'staging' | 'local';
  count: number;
  concurrency: number;
  emailPrefix: string;
  emailDomain: string;
  password: string;
}

function value(argv: string[], key: string): string | undefined {
  const exact = argv.indexOf(`--${key}`);
  if (exact >= 0) return argv[exact + 1]?.startsWith('--') ? undefined : argv[exact + 1];
  const prefix = `--${key}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function positiveInt(argv: string[], key: string, fallback: number): number {
  const parsed = Number(value(argv, key) ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${key} must be a positive integer.`);
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const target = (value(argv, 'target') ?? 'staging') as Args['target'];
  if (target !== 'staging' && target !== 'local') throw new Error('--target must be staging or local.');
  const count = positiveInt(argv, 'count', 25);
  if (count > 10_000) throw new Error('--count cannot exceed 10000 in one provisioning run.');
  return {
    target,
    count,
    concurrency: Math.min(50, positiveInt(argv, 'concurrency', 10)),
    emailPrefix: value(argv, 'email-prefix') ?? 'chaos',
    emailDomain: value(argv, 'email-domain') ?? (target === 'staging' ? 'quizball.io' : 'example.com'),
    password: value(argv, 'password') ?? 'ChaosTest12345!',
  };
}

function readEnv(path: string): Record<string, string> {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let raw = match[2]!;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    }
    out[match[1]!] = raw;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const envPath = resolve(process.cwd(), args.target === 'staging' ? '.env' : '.env.local');
  const env = readEnv(envPath);
  const supabaseUrl = process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? '';
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const apiBase = args.target === 'staging' ? 'https://api-staging.quizball.io' : 'http://127.0.0.1:3000';

  if (supabaseUrl.includes('lfbwhxvwubzeqkztghok') || apiBase.includes('api.quizball.io')) {
    throw new Error('PROD GUARD: refusing to provision load users against production.');
  }
  if (args.target === 'staging' && !supabaseUrl.includes('nsdfiprfmhdqhbfxfwpv')) {
    throw new Error(`PROD GUARD: expected the staging Supabase project, got ${supabaseUrl || '<missing>'}.`);
  }
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(`SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in ${envPath}.`);
  }

  console.log(`Provisioning ${args.count} confirmed ${args.target} load users (concurrency ${args.concurrency})…`);
  const startedAt = Date.now();
  const emails = await ensureChaosUsers({
    apiBase,
    supabaseUrl,
    serviceRoleKey,
    count: args.count,
    password: args.password,
    emailPrefix: args.emailPrefix,
    emailDomain: args.emailDomain,
    concurrency: args.concurrency,
  });
  console.log(`Ready: ${emails.length} users in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
  console.log(`Range: ${emails[0]} … ${emails.at(-1)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
