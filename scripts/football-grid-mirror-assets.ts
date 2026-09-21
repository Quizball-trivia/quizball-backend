#!/usr/bin/env npx tsx
// Mirror the served Football Grid portraits into another project's `imgs`
// bucket, so a release whose asset keys were rewritten to that origin
// (transform-labels --asset-origin-to) resolves there.
//
//   SUPABASE_SERVICE_ROLE_KEY=<target key> npx tsx scripts/football-grid-mirror-assets.ts \
//     --registry /tmp/grid/assets-2026090403.json \
//     --target-url https://lfbwhxvwubzeqkztghok.supabase.co --confirm-project lfbwhxvwubzeqkztghok \
//     [--verify-only] [--concurrency 12]
//
// The registry (from `football-grid-content.ts export … --registry-out`) maps
// every served asset key to a verified local file; keys that resolve to a
// storage object path are uploaded to the same path (upsert, immutable
// cache-control like the CDN publisher); slug keys (bundled with the web) and
// fallback-file entries are skipped and reported. --verify-only only HEADs
// the target public URLs.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storageObjectPathForAssetKey } from './football-grid-content.js';

const BUCKET = 'imgs';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const MIME: Record<string, string> = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };

function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

/** Network blips ("fetch failed", 429/5xx) get a few attempts; a definite 2xx/4xx answer is returned as is. */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.status < 500 && response.status !== 429) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt * attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function encodeObjectPath(objectPath: string): string {
  return objectPath.split('/').map(encodeURIComponent).join('/');
}

/** Supabase answers 400/404 for a public object that does not exist; anything else is not proof of absence. */
export function objectIsMissing(status: number): boolean {
  return status === 400 || status === 404;
}

export function planMirror(registry: Record<string, string>, fallbackFile?: string): { uploads: Array<{ key: string; objectPath: string; file: string }>; skipped: string[] } {
  const uploads: Array<{ key: string; objectPath: string; file: string }> = [];
  const skipped: string[] = [];
  for (const [key, file] of Object.entries(registry)) {
    const objectPath = storageObjectPathForAssetKey(key);
    if (!objectPath || (fallbackFile && path.resolve(file) === path.resolve(fallbackFile)) || path.basename(file).startsWith('_launch-fallback')) {
      skipped.push(key);
      continue;
    }
    uploads.push({ key, objectPath, file });
  }
  return { uploads, skipped };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const registryPath = option(args, '--registry');
  const targetUrl = option(args, '--target-url')?.replace(/\/+$/, '');
  const confirm = option(args, '--confirm-project');
  const concurrency = Number(option(args, '--concurrency') ?? 12);
  const verifyOnly = args.includes('--verify-only');
  if (!registryPath || !targetUrl || !confirm) throw new Error('--registry, --target-url and --confirm-project are required');
  if (!/^[a-z]{20}$/.test(confirm) || targetUrl !== `https://${confirm}.supabase.co`) {
    throw new Error('--target-url must be https://<ref>.supabase.co and match --confirm-project');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('--concurrency must be 1..32');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!verifyOnly && !serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY (target project) is required to upload');

  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as Record<string, string>;
  const { uploads, skipped } = planMirror(registry, option(args, '--fallback-file'));
  const unique = new Map<string, string>();
  for (const upload of uploads) unique.set(upload.objectPath, upload.file);
  process.stdout.write(`${uploads.length} keys → ${unique.size} objects to ${targetUrl}/${BUCKET}; ${skipped.length} keys skipped (bundled/fallback)\n`);

  const failures: string[] = [];
  let done = 0;
  let uploaded = 0;
  let present = 0;
  const queue = [...unique.entries()];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [objectPath, file] = item;
      const publicUrl = `${targetUrl}/storage/v1/object/public/${BUCKET}/${encodeObjectPath(objectPath)}`;
      try {
        const head = await fetchWithRetry(publicUrl, { method: 'HEAD' });
        if (head.ok) {
          present += 1;
        } else if (!objectIsMissing(head.status)) {
          // Never upsert over an object we could not inspect (429/5xx).
          failures.push(`${objectPath}: could not inspect target (${head.status})`);
        } else if (verifyOnly) {
          failures.push(`${objectPath}: missing on target (${head.status})`);
        } else {
          const bytes = await readFile(file);
          if (!(await stat(file)).isFile() || bytes.length === 0) throw new Error('local file empty');
          const response = await fetchWithRetry(`${targetUrl}/storage/v1/object/${BUCKET}/${encodeObjectPath(objectPath)}`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${serviceKey}`,
              'x-upsert': 'true',
              'cache-control': CACHE_CONTROL,
              'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
            },
            body: bytes,
          });
          if (!response.ok) throw new Error(`upload ${response.status}: ${(await response.text()).slice(0, 120)}`);
          const verify = await fetchWithRetry(publicUrl, { method: 'HEAD' });
          if (!verify.ok) throw new Error(`not readable after upload (${verify.status})`);
          uploaded += 1;
        }
      } catch (error) {
        failures.push(`${objectPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      done += 1;
      if (done % 500 === 0) process.stdout.write(`${done}/${unique.size}\n`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write(`${verifyOnly ? 'verified' : 'mirrored'}: present ${present}, uploaded ${uploaded}, failed ${failures.length}\n`);
  if (failures.length > 0) {
    process.stdout.write(`${failures.slice(0, 30).join('\n')}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
