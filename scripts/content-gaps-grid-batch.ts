// Football Grid fixes the HQ Content Fixer proposed and the Content Verifier confirmed → a private reviewed correction
// batch that football-grid-answer-corrections.ts turns into a correction release (reviewed, validated, published as usual).
//
//   build:   DATABASE_URL=… npx tsx scripts/content-gaps-grid-batch.ts build --source <export.json> --id content-fixer-20261112
//   publish: DATABASE_URL=… npx tsx scripts/content-gaps-grid-batch.ts mark-published --id content-fixer-20261112 --release <version> [--apply]
//            (after the release carrying the batch is active; prod also needs --confirm-production=lfbwhxvwubzeqkztghok)
//
// The batch (football facts) is written to the private store only, never to this repository.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';

const PROD_REF = 'lfbwhxvwubzeqkztghok';
const GRID_GAMES = ['football_grid', 'grid_daily'];

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const batchDir = () => process.env.FOOTBALL_GRID_PRIVATE_BATCH_DIR ?? join(homedir(), 'dev', 'quizball-private', 'football-grid-batches');

/** The alias languages a Grid manifest holds; Portuguese, German and French spellings are Latin-script names, kept as en. */
export function gridAliasLocale(locale: string): 'en' | 'ka' | 'es' | 'tr' | 'ru' {
  return locale === 'ka' || locale === 'es' || locale === 'tr' || locale === 'ru' ? locale : 'en';
}

type FixRow = { id: string; kind: string; payload: Record<string, unknown>; evidence: Array<{ url: string; quote: string }>; payload_hash: string };
type Receipt = { target: string; fixes: Array<{ id: string; payloadHash: string }> };

/**
 * Only what the exported pack can carry is included: a footballer it does not hold, or a criterion it does not have,
 * waits for a pack that does (the correction step would skip it silently, and the gap would be closed for nothing).
 */
export function batchFromFixes(fixes: FixRow[], pack: { namesById: Map<string, string>; criterionKeys: Set<string> }, alreadyBatched: Set<string> = new Set()) {
  const facts: Array<{ playerId: string; nameEn: string; criteria: string[]; url: string; fact: string; presentOnly: true }> = [];
  const aliases: Array<{ playerId: string; nameEn: string; alias: string; locale: string; presentOnly: true }> = [];
  const included: Array<{ id: string; payloadHash: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const f of fixes) {
    if (alreadyBatched.has(f.id)) { skipped.push({ id: f.id, reason: 'already in an unpublished batch' }); continue; }
    const pid = String(f.kind === 'alias' ? f.payload.entityId : f.payload.pid ?? '');
    const nameEn = pack.namesById.get(pid);
    if (!nameEn) { skipped.push({ id: f.id, reason: 'footballer not in the source pack' }); continue; }
    if (f.kind === 'membership') {
      const criteria = Array.isArray(f.payload.criterionKeys) ? f.payload.criterionKeys.map(String) : [];
      const url = f.evidence.find((e) => /^https:\/\//.test(e.url))?.url;
      if (!criteria.length || !url || typeof f.payload.fact !== 'string') { skipped.push({ id: f.id, reason: 'incomplete membership' }); continue; }
      if (!criteria.every((key) => pack.criterionKeys.has(key))) { skipped.push({ id: f.id, reason: 'criterion not in the source pack' }); continue; }
      facts.push({ playerId: pid, nameEn, criteria, url, fact: f.payload.fact, presentOnly: true });
    } else if (f.kind === 'alias') {
      aliases.push({ playerId: pid, nameEn, alias: String(f.payload.text).trim(), locale: gridAliasLocale(String(f.payload.locale)), presentOnly: true });
    } else {
      skipped.push({ id: f.id, reason: `kind ${f.kind}` });
      continue;
    }
    included.push({ id: f.id, payloadHash: f.payload_hash });
  }
  return { facts, aliases, included, skipped };
}

/** The Supabase project a connection string reaches, read from its decoded user name or host (never the raw text). */
export function projectRef(url: string): string {
  const u = new URL(url);
  const user = decodeURIComponent(u.username);
  const host = decodeURIComponent(u.hostname);
  const ref = /^postgres\.([a-z0-9]{20})$/.exec(user)?.[1] ?? /(?:^|\.)([a-z0-9]{20})\.supabase\.co$/.exec(host)?.[1];
  if (ref) return ref;
  if (host === '127.0.0.1' || host === 'localhost') return 'local';
  throw new Error('Cannot tell which project DATABASE_URL reaches');
}

function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL');
  return { sql: postgres(url, { max: 1, prepare: false, onnotice: () => undefined }), target: projectRef(url) };
}

/** Fix ids already in a batch of this database that has not been marked published. */
function batchedFixIds(target: string): Set<string> {
  const ids = new Set<string>();
  for (const file of readdirSync(batchDir()).filter((f) => f.endsWith('.fixes.json'))) {
    const receipt = JSON.parse(readFileSync(join(batchDir(), file), 'utf8')) as Receipt & { publishedAt?: string };
    if (receipt.target === target && !receipt.publishedAt) for (const f of receipt.fixes) ids.add(f.id);
  }
  return ids;
}

async function build() {
  const id = arg('id');
  const source = arg('source');
  if (!id || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(id) || !source) throw new Error('build needs --id <batch id> and --source <export.json>');
  const out = join(batchDir(), `${id}.json`);
  if (existsSync(out)) throw new Error(`${out} exists: pick a new batch id`);
  const manifest = JSON.parse(readFileSync(source, 'utf8')) as { players: Array<{ id: string; nameEn: string }>; criteria: Array<{ key: string }> };
  const pack = { namesById: new Map(manifest.players.map((p) => [p.id, p.nameEn])), criterionKeys: new Set(manifest.criteria.map((c) => c.key)) };
  const { sql, target } = connect();
  try {
    const fixes = await sql.begin('READ ONLY', (tx) => tx<FixRow[]>`
      SELECT id::text, kind, payload, evidence, md5(payload::text) AS payload_hash FROM content_gap_fixes
       WHERE status = 'verified' AND game = ANY(${GRID_GAMES}) AND kind IN ('membership', 'alias') ORDER BY id`);
    const batch = batchFromFixes(fixes, pack, batchedFixIds(target));
    if (!batch.included.length) { console.log(JSON.stringify({ included: 0, skipped: batch.skipped })); return; }
    writeFileSync(out, JSON.stringify({
      reviewer: 'hq-content-fixer-and-verifier', providerName: 'Sources cited by the HQ Content Fixer and confirmed from two publishers by the Content Verifier',
      facts: batch.facts, aliases: batch.aliases,
    }, null, 2), { flag: 'wx', mode: 0o600 });
    const receipt: Receipt = { target, fixes: batch.included };
    writeFileSync(join(batchDir(), `${id}.fixes.json`), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ batch: `private:${id}`, target, facts: batch.facts.length, aliases: batch.aliases.length, skipped: batch.skipped }));
  } finally {
    await sql.end();
  }
}

async function markPublished() {
  const id = arg('id');
  const version = Number(arg('release'));
  if (!id || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(id) || !Number.isSafeInteger(version)) throw new Error('mark-published needs --id <batch id> and --release <version>');
  const receiptPath = join(batchDir(), `${id}.fixes.json`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt & { publishedAt?: string };
  const { sql, target } = connect();
  if (receipt.target !== target) throw new Error(`Batch ${id} was built from ${receipt.target}, not ${target}`);
  const apply = has('apply');
  if (apply && target === PROD_REF && arg('confirm-production') !== PROD_REF) throw new Error(`Production needs --confirm-production=${PROD_REF}`);
  const ids = receipt.fixes.map((f) => f.id);
  const hashes = receipt.fixes.map((f) => f.payloadHash);
  try {
    const result = await sql.begin(async (tx) => {
      // The release that carries this batch must be live: published and not switched off as a whole.
      const live = await tx`SELECT 1 FROM football_grid_content_releases r
        WHERE r.version = ${version} AND r.status = 'published' AND r.relationship_snapshot->>'correctionBatch' = ${`private:${id}`}
          AND NOT EXISTS (SELECT 1 FROM football_grid_content_quarantines q WHERE q.release_id = r.id AND q.board_id IS NULL AND q.action = 'disable'
                            AND (q.expires_at IS NULL OR q.expires_at > now()))`;
      if (live.length !== 1) throw new Error(`Release ${version} is not a live release of private:${id}`);
      const fixes = await tx`UPDATE content_gap_fixes f SET status = 'published', revision = f.revision + 1, updated_at = now()
        FROM unnest(${ids}::bigint[], ${hashes}::text[]) AS r(id, hash)
        WHERE f.id = r.id AND md5(f.payload::text) = r.hash AND f.status = 'verified'
          AND f.game = ANY(${GRID_GAMES}) AND f.kind IN ('membership', 'alias') RETURNING f.id`;
      const published = fixes.map((f) => f.id as string);
      const gaps = await tx`UPDATE content_gaps g SET status = 'fixed', revision = g.revision + 1, updated_at = now()
        WHERE g.fix_id = ANY(${published}::bigint[]) AND g.status = 'verified' RETURNING id`;
      if (!apply) throw Object.assign(new Error('dry run'), { dry: { fixes: fixes.length, of: ids.length, gaps: gaps.length } });
      return { fixes: fixes.length, of: ids.length, gaps: gaps.length };
    }).catch((e: { dry?: unknown }) => { if (e.dry) return { dryRun: true, ...(e.dry as object) }; throw e; });
    if (apply) writeFileSync(receiptPath, JSON.stringify({ ...receipt, publishedAt: new Date().toISOString(), release: version }), { mode: 0o600 });
    console.log(JSON.stringify(result));
  } finally {
    await sql.end();
  }
}

if (process.argv[1]?.endsWith('content-gaps-grid-batch.ts')) {
  const command = process.argv[2];
  if (command === 'build') await build();
  else if (command === 'mark-published') await markPublished();
  else throw new Error('Usage: content-gaps-grid-batch <build|mark-published> …');
}
