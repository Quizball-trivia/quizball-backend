#!/usr/bin/env node

import { createHash } from 'node:crypto';
import postgres from 'postgres';
import sharp from 'sharp';

const databaseUrl = process.env.DATABASE_URL;
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const release = process.env.FOOTBALL_GRID_CDN_RELEASE ?? 'v1';
const bucket = 'imgs';
const objectPrefix = `football-grid/${release}/players`;
const dryRun = process.argv.includes('--dry-run');
const verifyOnly = process.argv.includes('--verify-only');
const retryFallbacks = process.argv.includes('--retry-fallbacks');
const limitArgument = process.argv.find((argument) => argument.startsWith('--limit='));
const concurrencyArgument = process.argv.find((argument) => argument.startsWith('--concurrency='));
const limit = limitArgument ? Number(limitArgument.split('=')[1]) : Number.POSITIVE_INFINITY;
const concurrency = concurrencyArgument ? Number(concurrencyArgument.split('=')[1]) : 40;
const PAGE_SIZE = 500;
const MAX_ATTEMPTS = 3;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

if (!databaseUrl || !supabaseUrl || !serviceKey) {
  throw new Error('DATABASE_URL, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY are required');
}
if (!databaseUrl.includes('nsdfiprfmhdqhbfxfwpv') && !/(localhost|127\.0\.0\.1)/.test(databaseUrl)) {
  throw new Error('Refusing to run: Football Grid CDN migration is restricted to staging or local databases');
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
  throw new Error('--concurrency must be an integer from 1 to 64');
}
if (!(Number.isFinite(limit) ? Number.isInteger(limit) && limit >= 0 : limit === Number.POSITIVE_INFINITY)) {
  throw new Error('--limit must be a non-negative integer');
}

type PlayerRow = {
  id: string;
  name: string;
  image_url: string | null;
  source_image_url: string | null;
  updated_at: Date;
};

type PreparedPlayer = {
  player: PlayerRow;
  imageUrl: string;
  imageCdn: Record<string, unknown>;
};

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1') ? false : 'require',
  max: 1,
  prepare: false,
  connect_timeout: 15,
  idle_timeout: 30,
  onnotice: () => {},
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await sleep(250 * (2 ** (attempt - 1)));
    }
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function encodeObjectPath(value: string) {
  return value.split('/').map(encodeURIComponent).join('/');
}

function publicUrl(objectPath: string) {
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${encodeObjectPath(objectPath)}`;
}

function storageUrl(objectPath: string) {
  return `${supabaseUrl}/storage/v1/object/${bucket}/${encodeObjectPath(objectPath)}`;
}

function isFirstPartyImage(value: string | null): boolean {
  if (!value) return false;
  try {
    const candidate = new URL(value);
    const ownOrigin = new URL(supabaseUrl!);
    return candidate.protocol === 'https:'
      && candidate.origin === ownOrigin.origin
      && candidate.pathname.startsWith('/storage/v1/object/public/imgs/');
  } catch {
    return false;
  }
}

function initials(name: string) {
  const parts = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts.at(-1)?.[0] ?? ''}`.toUpperCase();
}

function fallbackSvg(player: PlayerRow) {
  const digest = createHash('sha256').update(player.id).digest();
  const hue = ((digest[0] << 8) + digest[1]) % 360;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
  <rect width="320" height="320" rx="160" fill="hsl(${hue} 56% 35%)"/>
  <circle cx="160" cy="160" r="146" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="8"/>
  <text x="160" y="187" text-anchor="middle" font-family="Arial,sans-serif" font-size="92" font-weight="800" fill="#fff">${initials(player.name)}</text>
</svg>`);
}

async function downloadSource(player: PlayerRow) {
  if (!player.source_image_url || isFirstPartyImage(player.source_image_url)) return null;
  const response = await fetch(player.source_image_url, {
    headers: {
      'user-agent': 'QuizballFootballGridAssets/1.0 (nika@quizball.io)',
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`source returned ${response.status}`);
  const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
  if (!contentType.startsWith('image/')) throw new Error(`source returned ${contentType || 'no content type'}`);
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_SOURCE_BYTES) throw new Error(`source exceeds ${MAX_SOURCE_BYTES} bytes`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_SOURCE_BYTES) throw new Error(`invalid source size ${bytes.length}`);
  return bytes;
}

async function normalizePortrait(player: PlayerRow) {
  let source: Buffer | null = null;
  let sourceError: string | null = null;
  let usedFallback = false;
  if (player.source_image_url) {
    try {
      source = await withRetry(`download ${player.id}`, () => downloadSource(player));
    } catch (error) {
      sourceError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!source) {
    if (retryFallbacks) throw new Error(sourceError ?? 'original portrait source is unavailable');
    source = fallbackSvg(player);
    usedFallback = true;
  }
  try {
    const bytes = await sharp(source, { failOn: 'error', limitInputPixels: 25_000_000 })
      .rotate()
      .resize(320, 320, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82, effort: 1 })
      .toBuffer();
    return { bytes, usedFallback, sourceError };
  } catch (error) {
    const bytes = await sharp(fallbackSvg(player)).resize(320, 320).webp({ quality: 82, effort: 1 }).toBuffer();
    return {
      bytes,
      usedFallback: true,
      sourceError: sourceError ?? (error instanceof Error ? error.message : String(error)),
    };
  }
}

async function uploadPortrait(objectPath: string, bytes: Buffer) {
  const response = await fetch(storageUrl(objectPath), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey!,
      'Content-Type': 'image/webp',
      'Cache-Control': 'max-age=31536000, immutable',
      'x-upsert': 'true',
    },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`upload returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

async function preparePlayer(player: PlayerRow): Promise<PreparedPlayer> {
  const objectPath = `${objectPrefix}/${player.id}.webp`;
  const portrait = await normalizePortrait(player);
  await withRetry(`upload ${player.id}`, () => uploadPortrait(objectPath, portrait.bytes));
  const sha256 = createHash('sha256').update(portrait.bytes).digest('hex');
  return {
    player,
    imageUrl: publicUrl(objectPath),
    imageCdn: {
      source_url: player.source_image_url,
      object_path: objectPath,
      migrated_at: new Date().toISOString(),
      used_owned_fallback: portrait.usedFallback,
      source_error: portrait.sourceError,
      sha256,
      format: 'image/webp',
      width: 320,
      height: 320,
    },
  };
}

async function runConcurrent(players: PlayerRow[]) {
  let cursor = 0;
  const prepared: PreparedPlayer[] = [];
  const failures: Array<{ id: string; error: string }> = [];
  const workers = Array.from({ length: Math.min(concurrency, players.length) }, async () => {
    while (cursor < players.length) {
      const player = players[cursor];
      cursor += 1;
      try {
        prepared.push(await preparePlayer(player));
      } catch (error) {
        failures.push({ id: player.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  await Promise.all(workers);
  return { prepared, failures };
}

async function commitBatch(prepared: PreparedPlayer[]) {
  if (prepared.length === 0) return { updated: 0, conflicts: [] as string[] };
  const payload = prepared.map((entry) => ({
    id: entry.player.id,
    expected_image_url: entry.player.image_url,
    image_url: entry.imageUrl,
    image_cdn: entry.imageCdn,
  }));
  const rows = await sql<Array<{ id: string }>>`
    WITH updates AS (
      SELECT *
        FROM jsonb_to_recordset(${sql.json(payload)}) AS row(
          id uuid,
          expected_image_url text,
          image_url text,
          image_cdn jsonb
        )
    )
    UPDATE football_players AS player
       SET image_url = updates.image_url,
           source_payload = COALESCE(player.source_payload, '{}'::jsonb)
             || jsonb_build_object('image_cdn', updates.image_cdn)
      FROM updates
     WHERE player.id = updates.id
       AND player.image_url IS NOT DISTINCT FROM updates.expected_image_url
    RETURNING player.id::text AS id
  `;
  const updatedIds = new Set(rows.map((row) => row.id));
  return {
    updated: rows.length,
    conflicts: prepared.filter((entry) => !updatedIds.has(entry.player.id)).map((entry) => entry.player.id),
  };
}

async function countStoredPlayerObjects() {
  let offset = 0;
  let count = 0;
  const pageSize = 1_000;
  while (true) {
    const response = await fetch(`${supabaseUrl}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prefix: objectPrefix,
        limit: pageSize,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Storage listing returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const rows = await response.json() as Array<{ name?: string }>;
    count += rows.length;
    if (rows.length < pageSize) return count;
    offset += rows.length;
  }
}

async function verifyMigration() {
  const [counts] = await sql<Array<{ total: number; external: number; missing: number; migrated: number }>>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE image_url IS NULL)::int AS missing,
           count(*) FILTER (
             WHERE image_url IS NOT NULL
               AND image_url NOT LIKE ${`${supabaseUrl}/storage/v1/object/public/imgs/%`}
           )::int AS external,
           count(*) FILTER (
             WHERE image_url LIKE ${`${supabaseUrl}/storage/v1/object/public/imgs/${objectPrefix}/%`}
           )::int AS migrated
      FROM football_players
     WHERE data_quality_status = 'usable'
  `;
  const samples = await sql<Array<{ image_url: string }>>`
    WITH distributed AS (
      SELECT image_url,
             ntile(100) OVER (ORDER BY id) AS sample_bucket
        FROM football_players
       WHERE data_quality_status = 'usable'
         AND image_url LIKE ${`${supabaseUrl}/storage/v1/object/public/imgs/${objectPrefix}/%`}
    )
    SELECT min(image_url) AS image_url
      FROM distributed
     GROUP BY sample_bucket
     ORDER BY sample_bucket
  `;
  const failedSamples: string[] = [];
  await Promise.all(samples.map(async ({ image_url: url }) => {
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      if (!response.ok || !(response.headers.get('content-type') ?? '').startsWith('image/')) failedSamples.push(url);
    } catch {
      failedSamples.push(url);
    }
  }));
  const storedObjects = await countStoredPlayerObjects();
  return { ...counts, storedObjects, sampled: samples.length, failedSamples: failedSamples.length };
}

let afterId: string | null = null;
let discovered = 0;
let migrated = 0;
let ownedFallbacks = 0;
const failures: Array<{ id: string; error: string }> = [];

try {
  if (!verifyOnly) {
    while (discovered < limit) {
      const rows = retryFallbacks
        ? await sql<PlayerRow[]>`
            SELECT id::text, name, image_url, updated_at,
                   source_payload->'image_cdn'->>'source_url' AS source_image_url
              FROM football_players
             WHERE data_quality_status = 'usable'
               AND source_payload->'image_cdn'->>'used_owned_fallback' = 'true'
               AND source_payload->'image_cdn'->>'source_url' IS NOT NULL
               AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
             ORDER BY id
             LIMIT ${PAGE_SIZE}
          `
        : await sql<PlayerRow[]>`
            SELECT id::text, name, image_url, image_url AS source_image_url, updated_at
              FROM football_players
             WHERE data_quality_status = 'usable'
               AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
             ORDER BY id
             LIMIT ${PAGE_SIZE}
          `;
      if (rows.length === 0) break;
      afterId = rows.at(-1)?.id ?? afterId;
      const candidates = retryFallbacks
        ? rows
        : rows.filter((player) => !isFirstPartyImage(player.image_url));
      const remaining = Number.isFinite(limit) ? Math.max(0, limit - discovered) : candidates.length;
      const selected = candidates.slice(0, remaining);
      discovered += selected.length;
      if (dryRun || selected.length === 0) continue;

      const batch = await runConcurrent(selected);
      failures.push(...batch.failures);
      const committed = await commitBatch(batch.prepared);
      migrated += committed.updated;
      ownedFallbacks += batch.prepared.filter((entry) => entry.imageCdn.used_owned_fallback === true).length;
      failures.push(...committed.conflicts.map((id) => ({ id, error: 'concurrent database update; CDN object left unreferenced' })));
      console.log(JSON.stringify({ progress: { discovered, migrated, ownedFallbacks, failures: failures.length } }));
    }
  }

  const verification = dryRun ? null : await verifyMigration();
  console.log(JSON.stringify({
    mode: dryRun ? 'dry-run' : verifyOnly ? 'verify-only' : 'migrate',
    release,
    discovered,
    migrated,
    ownedFallbacks,
    failureCount: failures.length,
    failures: failures.slice(0, 50),
    verification,
  }, null, 2));
  const requireCompleteCorpus = verifyOnly || !Number.isFinite(limit);
  if (!dryRun && (
    failures.length !== 0
    || (requireCompleteCorpus && (
      verification?.external !== 0
      || verification?.missing !== 0
      || (verification?.storedObjects ?? 0) < (verification?.migrated ?? 0)
      || verification?.failedSamples !== 0
    ))
  )) {
    process.exitCode = 1;
  }
} finally {
  await sql.end({ timeout: 5 });
}
