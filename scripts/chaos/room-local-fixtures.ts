/** Local-only auth fixture. No production keys, Supabase requests, or app auth bypasses. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import postgres from 'postgres';
import { assertLocalUrl } from './room-fleet-oracle.js';

const args = process.argv.slice(2);
const arg = (key: string, fallback: string) => args[args.indexOf(`--${key}`) + 1] ?? fallback;
// Missing flags must not accidentally read argv[0].
const flag = (key: string, fallback: string) => (args.includes(`--${key}`) ? arg(key, fallback) : fallback);
const database = new URL(flag('database', 'postgresql://postgres@127.0.0.1:5436/quizball_load_local'));
if (
  !['127.0.0.1', 'localhost'].includes(database.hostname) ||
  !/^\/quizball_load_[a-z0-9_]+$/.test(database.pathname)
)
  throw new Error('Dedicated local quizball_load_* database required');
const api = assertLocalUrl(flag('api', 'http://127.0.0.1:8050')).origin;
const port = Number(flag('auth-port', '8062'));
const count = Number(flag('users', '1200'));
if (
  !Number.isInteger(count) ||
  count < 6 ||
  count > 6000 ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Invalid fixture size/port');
const out = resolve(flag('out', 'room-load-artifacts'));
mkdirSync(out, { recursive: true });
const issuer = `http://127.0.0.1:${port}/auth/v1`;
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'room-load-local', alg: 'RS256', use: 'sig' };
const sql = postgres(database.href, { max: 1 });
const run = randomUUID().slice(0, 8);
const users = Array.from({ length: count }, (_, i) => ({
  id: randomUUID(),
  nickname: `Load ${run} ${i}`,
  email: `room-load-${run}-${i}@example.invalid`,
  country: 'AR',
  onboarding_complete: true,
  is_seed: true,
}));
await sql`INSERT INTO users ${sql(users, 'id', 'nickname', 'email', 'country', 'onboarding_complete', 'is_seed')}`;
await sql`INSERT INTO user_identities ${sql(
  users.map((u) => ({ user_id: u.id, subject: u.id, provider: 'supabase', email: u.email })),
  'user_id',
  'subject',
  'provider',
  'email',
)}`;
const [category] =
  await sql`SELECT q.category_id FROM questions q JOIN question_payloads p ON p.question_id=q.id JOIN categories c ON c.id=q.category_id WHERE c.is_active AND q.status='published' AND q.visibility='public' AND q.ranked_eligible AND p.payload->>'type'='mcq_single' GROUP BY q.category_id HAVING count(*) >= 100 ORDER BY count(*) DESC LIMIT 1`;
if (!category) throw new Error('Need a category with at least 100 playable published MCQ fixtures');
await sql.end();
const manifest = {
  apiBase: api,
  localAuthFixture: true,
  partyCategoryId: category.category_id,
  createdAt: new Date().toISOString(),
  users: await Promise.all(
    users.map(async (u) => ({
      userId: u.id,
      token: await new SignJWT({
        email: u.email,
        role: 'authenticated',
        user_metadata: { name: u.nickname },
        app_metadata: { provider: 'email' },
      })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setSubject(u.id)
        .setIssuer(issuer)
        .setAudience('authenticated')
        .setIssuedAt()
        .setExpirationTime('8h')
        .sign(privateKey),
    })),
  ),
};
writeFileSync(resolve(out, 'users.json'), JSON.stringify(manifest), { mode: 0o600 });
const server = createServer((req, res) => {
  if (req.url === '/jwks') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  // No remote forwarding, admin APIs, storage or mail. Only local JWKS is served.
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Local JWKS fixture ready; ${count} synthetic users; manifest ${resolve(out, 'users.json')}`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
