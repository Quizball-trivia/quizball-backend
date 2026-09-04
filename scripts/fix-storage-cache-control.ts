/**
 * Repair `cache-control` metadata on Supabase Storage objects.
 *
 * Why this matters — measured against prod on 2026-09-04:
 *
 *   stored cacheControl      | /object/public/ serves | /render/image/ serves
 *   -------------------------|------------------------|----------------------
 *   no-cache      (736 objs) | no-cache               | no-cache
 *   max-age=31536000 (3,663) | no-cache               | max-age=31536000
 *
 * `/object/public/` ALWAYS answers `no-cache` on this project regardless of
 * stored metadata (verified with a freshly-uploaded object on a never-served
 * path), so nothing we store can make that endpoint cacheable. The transform
 * endpoint DOES honour stored metadata — which is why the web app now routes
 * images through it (see frontend `lib/images/remoteImage.ts`).
 *
 * That leaves the 736 objects whose stored value is `no-cache`: they stay
 * uncacheable even through the transform endpoint, so Supabase's CDN
 * revalidates with origin on every request and none of that traffic is billed
 * as (free) cached egress. This script repairs those objects so the transform
 * endpoint can cache them for a year.
 *
 * The backend's own upload paths already set this header
 * (question-image-storage.service.ts, feedback-storage.service.ts); these are
 * historical objects written by CMS/scripts that did not.
 *
 * How: Storage exposes no metadata-patch call, and `object/copy` onto the same
 * key returns 409 Duplicate. What works (verified end-to-end on staging) is
 * re-uploading the identical bytes with `x-upsert: true` and the
 * `cache-control` header — the object id and bytes are preserved (md5 verified
 * unchanged), only metadata is rewritten. Bytes are re-uploaded, so run it
 * against a bucket you have a backup of, and dry-run first.
 *
 * Reversibility: Supabase Storage keeps NO version history, and this
 * re-uploads object bytes, so a truncated download that slipped past the
 * guards would be unrecoverable from Supabase. Every object is therefore
 * written to --backup-dir BEFORE its repair, and verified byte-for-byte
 * against what was uploaded. `--restore` puts a backup directory back.
 *
 * Usage — dry-run is the default; --yes is required to write:
 *   npx tsx scripts/fix-storage-cache-control.ts
 *   npx tsx scripts/fix-storage-cache-control.ts --limit=20 --yes
 *   npx tsx scripts/fix-storage-cache-control.ts --yes --backup-dir=./backup
 *   npx tsx scripts/fix-storage-cache-control.ts --restore=./backup --yes
 *
 * Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from env. It PRINTS THE
 * TARGET PROJECT REF before doing anything — check it before passing --yes.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { sql } from '../src/db/index.js';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DEFAULT_BUCKET = 'imgs';
const CONCURRENCY = 4;

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

interface StaleObject {
  name: string;
  cache_control: string | null;
  mimetype: string | null;
  size_bytes: string | null;
}

function arg(flag: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${flag}=`))?.split('=')[1];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Re-uploads an object's own bytes so Storage rewrites its metadata.
 *
 * Order matters: download, verify the size against what the DB recorded, write
 * the backup to disk, and only then upload. A truncated or empty download
 * aborts before anything is written to Storage, and whatever the upload
 * replaces is already on disk.
 */
async function repairObject(
  baseUrl: string,
  serviceKey: string,
  bucket: string,
  object: StaleObject,
  backupDir: string,
): Promise<void> {
  const encoded = object.name.split('/').map(encodeURIComponent).join('/');
  const download = await fetch(`${baseUrl}/storage/v1/object/public/${bucket}/${encoded}`);
  if (!download.ok) throw new Error(`download failed (${download.status})`);
  const bytes = new Uint8Array(await download.arrayBuffer());

  const expected = Number(object.size_bytes ?? 0);
  if (expected > 0 && bytes.byteLength !== expected) {
    throw new Error(`size mismatch: got ${bytes.byteLength}, expected ${expected}`);
  }
  if (bytes.byteLength === 0) throw new Error('refusing to upload 0 bytes');

  // Backup BEFORE the write, and read it back — an unflushed or short write
  // would otherwise leave us believing we had a copy that we do not.
  const backupPath = join(backupDir, bucket, object.name);
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(backupPath, bytes);
  // Bytes alone are not an undo: restoring must put back the ORIGINAL
  // cache-control and mimetype, not the value this run is applying.
  await writeFile(
    `${backupPath}.meta.json`,
    JSON.stringify({ cacheControl: object.cache_control, mimetype: object.mimetype }),
  );
  const verified = new Uint8Array(await readFile(backupPath));
  if (md5(verified) !== md5(bytes)) throw new Error('backup verification failed');

  const upload = await fetch(`${baseUrl}/storage/v1/object/${bucket}/${encoded}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': object.mimetype ?? 'application/octet-stream',
      'cache-control': CACHE_CONTROL,
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!upload.ok) {
    throw new Error(`upload failed (${upload.status}): ${(await upload.text()).slice(0, 200)}`);
  }

  // Read back what Storage now serves and compare to the backup. This is the
  // check that would catch a corrupted write while the original is still on
  // disk to restore from.
  const readback = await fetch(`${baseUrl}/storage/v1/object/public/${bucket}/${encoded}`, {
    cache: 'no-store',
  });
  if (!readback.ok) throw new Error(`readback failed (${readback.status})`);
  const after = new Uint8Array(await readback.arrayBuffer());
  if (md5(after) !== md5(bytes)) {
    throw new Error(`CORRUPTION: readback md5 differs — restore from ${backupPath}`);
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Puts a backup directory back, byte for byte. */
async function restore(baseUrl: string, serviceKey: string, dir: string, apply: boolean): Promise<void> {
  const files: string[] = [];
  for await (const f of walk(dir)) if (!f.endsWith('.meta.json')) files.push(f);
  console.log(`restore source : ${dir}`);
  console.log(`files          : ${files.length}`);
  console.log(`mode           : ${apply ? 'APPLY' : 'DRY RUN (pass --yes to write)'}\n`);
  if (!apply) {
    for (const f of files.slice(0, 10)) console.log(`  ${relative(dir, f)}`);
    if (files.length > 10) console.log(`  … and ${files.length - 10} more`);
    return;
  }
  let done = 0;
  let failed = 0;
  for (const file of files) {
    const rel = relative(dir, file);
    const bucket = rel.split('/')[0];
    const name = rel.slice(bucket.length + 1);
    const encoded = name.split('/').map(encodeURIComponent).join('/');
    try {
      const bytes = new Uint8Array(await readFile(file));
      // Put back what was there before the repair, not what the repair applied.
      let meta: { cacheControl?: string | null; mimetype?: string | null } = {};
      try {
        meta = JSON.parse(await readFile(`${file}.meta.json`, 'utf8'));
      } catch {
        // Pre-manifest backup: fall back to letting Storage infer defaults.
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${serviceKey}`,
        'x-upsert': 'true',
      };
      if (meta.cacheControl) headers['cache-control'] = meta.cacheControl;
      if (meta.mimetype) headers['Content-Type'] = meta.mimetype;
      const res = await fetch(`${baseUrl}/storage/v1/object/${bucket}/${encoded}`, {
        method: 'POST',
        headers,
        body: bytes,
      });
      if (!res.ok) throw new Error(`${res.status}`);
      done += 1;
    } catch (error) {
      failed += 1;
      console.error(`  FAILED ${rel}: ${(error as Error).message}`);
    }
  }
  console.log(`\nrestored ${done}, failed ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const bucket = arg('bucket') ?? DEFAULT_BUCKET;
  const limitRaw = arg('limit');
  const limit = limitRaw === undefined ? 0 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 0) {
    // Number('twenty') is NaN, and NaN > 0 is false — an unvalidated typo would
    // silently drop the LIMIT and repair the whole bucket.
    throw new Error(`--limit must be a non-negative integer (got "${limitRaw}")`);
  }
  const apply = process.argv.includes('--yes');
  const restoreDir = arg('restore');

  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const ref = new URL(supabaseUrl).hostname.split('.')[0];

  if (restoreDir) {
    console.log(`project ref    : ${ref}`);
    await restore(supabaseUrl, serviceKey, restoreDir, apply);
    await sql.end();
    return;
  }

  // Default keeps each run's originals separate, so a second run cannot
  // overwrite the backup taken before the first.
  const backupDir =
    arg('backup-dir') ?? `./storage-backup-${ref}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;

  const rows = (await sql`
    SELECT name,
           metadata->>'cacheControl' AS cache_control,
           metadata->>'mimetype' AS mimetype,
           metadata->>'size' AS size_bytes
    FROM storage.objects
    WHERE bucket_id = ${bucket}
      AND coalesce(metadata->>'cacheControl', 'no-cache') NOT LIKE '%max-age=31536000%'
      -- Bucket-placeholder files are not images and the bucket rejects their
      -- mime type on re-upload (415 invalid_mime_type). They are never served,
      -- so skip them rather than fail every run on the same object.
      AND coalesce(metadata->>'mimetype', '') LIKE 'image/%'
    ORDER BY (metadata->>'size')::bigint DESC NULLS LAST
    ${limit > 0 ? sql`LIMIT ${limit}` : sql``}
  `) as unknown as StaleObject[];

  const totalBytes = rows.reduce((sum, r) => sum + Number(r.size_bytes ?? 0), 0);
  console.log(`project ref : ${ref}`);
  console.log(`bucket      : ${bucket}`);
  console.log(`objects     : ${rows.length} (${(totalBytes / 1048576).toFixed(1)} MB to re-upload)`);
  console.log(`target      : ${CACHE_CONTROL}`);
  console.log(`backup dir  : ${backupDir}`);
  console.log(`mode        : ${apply ? 'APPLY' : 'DRY RUN (pass --yes to write)'}\n`);

  const byValue = new Map<string, number>();
  for (const r of rows) {
    const key = r.cache_control ?? '(null)';
    byValue.set(key, (byValue.get(key) ?? 0) + 1);
  }
  for (const [value, count] of [...byValue].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${value}`);
  }

  if (!apply || rows.length === 0) {
    console.log('\nno changes made');
    await sql.end();
    return;
  }

  let done = 0;
  let failed = 0;
  const queue = [...rows];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let next = queue.pop(); next; next = queue.pop()) {
        try {
          await repairObject(supabaseUrl, serviceKey, bucket, next, backupDir);
          done += 1;
          if (done % 50 === 0) console.log(`  ${done}/${rows.length}`);
        } catch (error) {
          failed += 1;
          console.error(`  FAILED ${next.name}: ${(error as Error).message}`);
        }
      }
    }),
  );

  console.log(`\nrepaired ${done}, failed ${failed}`);
  console.log(`originals saved to ${backupDir}`);
  console.log(`to undo: npx tsx scripts/fix-storage-cache-control.ts --restore=${backupDir} --yes`);
  if (failed > 0) process.exitCode = 1;
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
