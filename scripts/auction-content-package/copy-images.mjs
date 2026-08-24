#!/usr/bin/env node
/**
 * Copy the auction player images referenced by the content package from the
 * STAGING storage bucket to the PROD bucket, then verify every object by
 * public HTTP fetch + byte-for-byte checksum against the staging original.
 *
 * Reads image paths from the package's football_players.csv (single source of
 * truth — exactly the shipped players, nothing else). Uploads are idempotent
 * (upsert). ~1,311 objects, ~13 MB total.
 *
 * Usage:
 *   PROD_SERVICE_ROLE_KEY=... node copy-images.mjs <package-dir> [--verify-only]
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const STAGING = 'https://nsdfiprfmhdqhbfxfwpv.supabase.co';
const PROD = 'https://lfbwhxvwubzeqkztghok.supabase.co';
const pkg = process.argv[2];
const verifyOnly = process.argv.includes('--verify-only');
const key = process.env.PROD_SERVICE_ROLE_KEY;
if (!pkg || (!key && !verifyOnly)) {
  console.error('usage: PROD_SERVICE_ROLE_KEY=... node copy-images.mjs <package-dir> [--verify-only]');
  process.exit(1);
}

const csv = readFileSync(`${pkg}/football_players.csv`, 'utf8').split('\n');
const header = csv[0].split(',');
const urlIdx = header.indexOf('image_url');
const paths = new Set();
for (const line of csv.slice(1)) {
  // image_url is a plain https URL — never quoted/comma-containing in our data,
  // but parse defensively: take the field only if it matches the bucket shape.
  const m = line.match(/https:\/\/nsdfiprfmhdqhbfxfwpv\.supabase\.co\/storage\/v1\/object\/public\/imgs\/([^",\s]+)/);
  if (m) paths.add(m[1]);
}
const expected = readFileSync(`${pkg}/expected-counts.txt`, 'utf8')
  .split('\n').find((l) => l.startsWith('players|'));
const expectedPlayers = Number(expected?.split('|')[1] ?? NaN);
if (!Number.isFinite(expectedPlayers) || paths.size !== expectedPlayers) {
  console.error(`image path count ${paths.size} != manifest players ${expectedPlayers}`);
  process.exit(1);
}
console.log(`objects referenced by package: ${paths.size} (matches manifest)`);

const sha = (buf) => createHash('sha256').update(Buffer.from(buf)).digest('hex');
let copied = 0, verified = 0, failed = 0;
const all = [...paths];
const CONCURRENCY = 8;

async function processOne(path) {
  const src = await fetch(`${STAGING}/storage/v1/object/public/imgs/${path}`);
  if (!src.ok) throw new Error(`staging fetch ${src.status} for ${path}`);
  const body = await src.arrayBuffer();
  const want = sha(body);

  if (!verifyOnly) {
    const up = await fetch(`${PROD}/storage/v1/object/imgs/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'image/webp',
        'x-upsert': 'true',
        'Cache-Control': 'public, max-age=31536000',
      },
      body,
    });
    if (!up.ok) throw new Error(`prod upload ${up.status} for ${path}: ${await up.text()}`);
    copied += 1;
  }

  const check = await fetch(`${PROD}/storage/v1/object/public/imgs/${path}`);
  if (!check.ok) throw new Error(`prod verify fetch ${check.status} for ${path}`);
  const got = sha(await check.arrayBuffer());
  if (got !== want) throw new Error(`checksum mismatch for ${path}`);
  verified += 1;
}

for (let i = 0; i < all.length; i += CONCURRENCY) {
  const batch = all.slice(i, i + CONCURRENCY);
  const results = await Promise.allSettled(batch.map(processOne));
  for (const [j, r] of results.entries()) {
    if (r.status === 'rejected') {
      failed += 1;
      console.error(`FAIL ${batch[j]}: ${r.reason.message}`);
    }
  }
  if ((i / CONCURRENCY) % 20 === 0) console.log(`progress: ${Math.min(i + CONCURRENCY, all.length)}/${all.length}`);
}

console.log(`done: copied=${copied} verified=${verified} failed=${failed} of ${all.length}`);
if (failed > 0 || verified !== all.length) process.exit(1);
