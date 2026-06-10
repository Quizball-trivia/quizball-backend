/**
 * Re-ingest + optimize MCQ question images.
 *
 * The CMS bulk import tried to store question images in
 * `imgs/question-images/<category-slug>/…` but Wikimedia rate-limited it
 * (storage_status='external_fallback', storage_error='… 429'), and the ones it
 * DID store are full-res PNGs (~2 MB). This script makes every image MCQ serve
 * from our Supabase CDN as an optimized webp:
 *
 *   for each mcq_single payload with a non-empty image.url:
 *     1. download the current image (our bucket PNG or the external source),
 *        politely for Wikimedia (UA + delay + 429 backoff)
 *     2. resize to max 1200px wide + encode webp q75 (sharp)
 *     3. upload to imgs/question-images/<category-slug>/<question-id>.webp
 *     4. update payload.image: url/width/height + storage_status='stored'
 *        (preserves the payload's jsonb kind — string payloads stay strings)
 *
 * Old objects are left in place so cached/in-flight DTOs keep working.
 *
 * Usage (sharp is not a backend dependency — install it ephemerally):
 *   npm i --no-save sharp
 *   npx tsx scripts/optimize-question-images.ts [--include-drafts] [--limit=N] [--dry-run]
 *
 * Reads DATABASE_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from env
 * (falls back to .env via dotenv through src/db import).
 */
import { sql } from '../src/db/index.js';

const WIKI_DELAY_MS = 400;
const USER_AGENT = 'QuizballImageOptimizer/1.0 (ops@quizball.io)';
const MAX_WIDTH = 1200;
const WEBP_QUALITY = 75;

interface WorkRow {
  question_id: string;
  category_slug: string;
  payload_kind: 'object' | 'string';
  payload_text: string;
  status: string;
}

interface ImagePayload {
  url: string;
  width?: number;
  height?: number;
  storage_status?: string;
  storage_error?: string | null;
  storage_attempted_at?: string | null;
  source_url?: string | null;
  [k: string]: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadWithRetry(url: string): Promise<Buffer> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 429 && attempt < 3) {
      const backoff = 2000 * attempt;
      console.log(`  429 from ${new URL(url).host}, backing off ${backoff}ms`);
      await sleep(backoff);
      continue;
    }
    throw new Error(`download ${res.status}`);
  }
  throw new Error('download retries exhausted');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const includeDrafts = args.includes('--include-drafts');
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  let limit: number | null = null;
  if (limitArg) {
    const parsed = Number(limitArg.split('=')[1]);
    // A typo'd --limit must NOT silently fall through to "process everything"
    // — this script does bulk writes.
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error(`Invalid --limit value: ${limitArg.split('=')[1]} (expected a positive integer)`);
      process.exit(1);
    }
    limit = parsed;
  }

  let sharp: typeof import('sharp');
  try {
    sharp = (await import('sharp')).default as never;
  } catch {
    console.error('sharp is not installed. Run: npm i --no-save sharp');
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(1);
  }

  const statusCondition = includeDrafts
    ? sql`q.status IN ('published', 'draft')`
    : sql`q.status = 'published'`;
  const rows = await sql<WorkRow[]>`
    SELECT q.id AS question_id,
           c.slug AS category_slug,
           jsonb_typeof(qp.payload) AS payload_kind,
           (CASE WHEN jsonb_typeof(qp.payload) = 'string' THEN qp.payload #>> '{}'
                 ELSE qp.payload::text END) AS payload_text,
           q.status
    FROM questions q
    JOIN categories c ON c.id = q.category_id
    JOIN question_payloads qp ON qp.question_id = q.id
    WHERE q.type = 'mcq_single'
      AND ${statusCondition}
    ORDER BY q.status, c.slug, q.id
  `;

  // Filter to rows that actually have an image and still need work.
  const work: Array<{ row: WorkRow; payload: Record<string, unknown>; image: ImagePayload }> = [];
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const image = payload.image as ImagePayload | undefined;
    if (!image?.url) continue;
    const alreadyOptimized = image.url.includes(`${supabaseUrl}/storage/v1/object/public/imgs/question-images/`)
      && image.url.endsWith('.webp');
    if (alreadyOptimized) continue;
    work.push({ row, payload, image });
  }

  const todo = limit ? work.slice(0, limit) : work;
  console.log(`${rows.length} mcq payloads scanned, ${work.length} need optimization, processing ${todo.length}${dryRun ? ' (DRY RUN)' : ''}\n`);

  let ok = 0;
  let failed = 0;
  let beforeTotal = 0;
  let afterTotal = 0;
  const failures: Array<{ id: string; url: string; error: string }> = [];

  for (const { row, payload, image } of todo) {
    const isExternal = !image.url.startsWith(supabaseUrl);
    try {
      const original = await downloadWithRetry(image.url);
      const webp = await sharp(original)
        .resize({ width: MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      const meta = await sharp(webp).metadata();

      const objectPath = `question-images/${row.category_slug}/${row.question_id}.webp`;
      const publicUrl = `${supabaseUrl}/storage/v1/object/public/imgs/${objectPath}`;

      if (!dryRun) {
        const up = await fetch(`${supabaseUrl}/storage/v1/object/imgs/${objectPath}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'image/webp',
            'x-upsert': 'true',
            'Cache-Control': 'max-age=31536000',
          },
          body: new Uint8Array(webp),
        });
        if (!up.ok) throw new Error(`upload ${up.status}: ${await up.text()}`);

        const updatedImage: ImagePayload = {
          ...image,
          url: publicUrl,
          width: meta.width ?? image.width,
          height: meta.height ?? image.height,
          source_url: image.source_url ?? image.url,
          storage_status: 'stored',
          storage_error: null,
          storage_attempted_at: new Date().toISOString(),
        };
        const updatedPayload = { ...payload, image: updatedImage };

        // Preserve the payload's jsonb kind: most rows store the payload as a
        // jsonb STRING (the CMS writes it stringified) — keep that contract.
        if (row.payload_kind === 'string') {
          await sql`
            UPDATE question_payloads
            SET payload = to_jsonb(${JSON.stringify(updatedPayload)}::text)
            WHERE question_id = ${row.question_id}
          `;
        } else {
          await sql`
            UPDATE question_payloads
            SET payload = ${sql.json(updatedPayload as never)}
            WHERE question_id = ${row.question_id}
          `;
        }
      }

      ok += 1;
      beforeTotal += original.length;
      afterTotal += webp.length;
      console.log(
        `${(original.length / 1024).toFixed(0).padStart(6)} KB -> ${(webp.length / 1024).toFixed(0).padStart(4)} KB  [${row.status}] ${row.category_slug}/${row.question_id}${isExternal ? ' (was external)' : ''}`,
      );
    } catch (error) {
      failed += 1;
      failures.push({ id: row.question_id, url: image.url, error: String(error) });
      console.error(`FAIL [${row.status}] ${row.category_slug}/${row.question_id}: ${String(error)}`);
    }

    if (isExternal) await sleep(WIKI_DELAY_MS);
  }

  console.log(`\nDone: ${ok} optimized, ${failed} failed`);
  console.log(`Bytes: ${(beforeTotal / 1024 / 1024).toFixed(1)} MB -> ${(afterTotal / 1024 / 1024).toFixed(1)} MB`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${f.id} ${f.url} — ${f.error}`);
  }
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
