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
 * Usage — dry-run is the default; --yes is required to write:
 *   npx tsx scripts/fix-storage-cache-control.ts
 *   npx tsx scripts/fix-storage-cache-control.ts --limit=20 --yes
 *   npx tsx scripts/fix-storage-cache-control.ts --bucket=imgs --yes
 *
 * Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from env. It PRINTS THE
 * TARGET PROJECT REF before doing anything — check it before passing --yes.
 */
import { sql } from '../src/db/index.js';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DEFAULT_BUCKET = 'imgs';
const CONCURRENCY = 4;

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
 * Re-uploads an object's own bytes so Storage rewrites its metadata. Verifies
 * the download succeeded before writing — a failed GET must never truncate a
 * live object.
 */
async function repairObject(
  baseUrl: string,
  serviceKey: string,
  bucket: string,
  object: StaleObject,
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
}

async function main(): Promise<void> {
  const bucket = arg('bucket') ?? DEFAULT_BUCKET;
  const limit = Number(arg('limit') ?? '0');
  const apply = process.argv.includes('--yes');

  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const ref = new URL(supabaseUrl).hostname.split('.')[0];

  const rows = (await sql`
    SELECT name,
           metadata->>'cacheControl' AS cache_control,
           metadata->>'mimetype' AS mimetype,
           metadata->>'size' AS size_bytes
    FROM storage.objects
    WHERE bucket_id = ${bucket}
      AND coalesce(metadata->>'cacheControl', 'no-cache') NOT LIKE '%max-age=31536000%'
    ORDER BY (metadata->>'size')::bigint DESC NULLS LAST
    ${limit > 0 ? sql`LIMIT ${limit}` : sql``}
  `) as unknown as StaleObject[];

  const totalBytes = rows.reduce((sum, r) => sum + Number(r.size_bytes ?? 0), 0);
  console.log(`project ref : ${ref}`);
  console.log(`bucket      : ${bucket}`);
  console.log(`objects     : ${rows.length} (${(totalBytes / 1048576).toFixed(1)} MB to re-upload)`);
  console.log(`target      : ${CACHE_CONTROL}`);
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
          await repairObject(supabaseUrl, serviceKey, bucket, next);
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
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
