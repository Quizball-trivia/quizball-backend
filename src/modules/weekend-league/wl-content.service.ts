/**
 * WL content import — the editor's CMS uploads into the protected pool.
 *
 * check   : validate WL shape, dedupe by CONTENT against the wl_private pool,
 *           the published public bank and every question ever dealt in a real
 *           tournament, probe photos, resolve career crests. Pure read.
 * import  : create the batch + one row per uploaded question FIRST, then per
 *           row (serialized process-wide, re-checked right before insert):
 *           photo = the bytes OUR probe downloaded, normalized and uploaded to
 *           our storage (never a client-supplied storage URL or source_url) →
 *           insert draft + link row in ONE transaction → translate → lock,
 *           re-read, WL shape + hosted-photo + bilingual checks, expand aliases,
 *           publish validation, publish (visibility forced to wl_private) in
 *           ONE transaction. Rows that fail stay draft and are reported at
 *           their file position.
 * undo    : delete the batch's questions no tournament / reseed backup refers
 *           to (prod and staging); staging cleanup is retryable.
 * runway  : fresh editor inventory vs. what the seeder can actually draw.
 * next    : the frozen content of the coming event + an atomic, restorable reseed.
 */

import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import sharp from 'sharp';
import { sql } from '../../db/index.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import type { I18nField, Json } from '../../db/types.js';
import { assertPublishableContent, normalizePayload } from '../questions/questions.service.js';
import { translationService } from '../questions/translation.service.js';
import { stagingSyncService } from '../questions/staging-sync.service.js';
import {
  DEFAULT_QUESTION_IMAGE_HEIGHT,
  DEFAULT_QUESTION_IMAGE_WIDTH,
  normalizeImageToTransparentPng,
  isWlImportOwnedImageUrl,
  listStoredQuestionImages,
  removeStoredQuestionImages,
  uploadQuestionImageBuffer,
  WL_IMPORT_PHOTO_DIR,
} from '../questions/question-image-storage.service.js';
import { invalidateCategoryCache } from '../lobbies/lobbies.service.js';
import {
  contentKeysOf,
  expandAcceptedAnswers,
  WL_CONTENT_KINDS,
  WL_KIND_TO_TYPE,
  wlShapeIssues,
  type WlShapeIssue,
} from './wl-content-normalize.js';
import { crestUrl, findCrestClub, resolveCrests } from './wl-crest-registry.js';
import { isForbiddenHostname, isPrivateAddress } from './wl-content-net.js';
import {
  payloadFullyBilingual,
  WL_GAME_COUNT,
  WL_REPEAT_AVOID_DAYS,
  wlInsertTournamentSlots,
  wlLockContentAllocation,
  wlPlanTournamentContent,
  wlSourcesTakenElsewhere,
  wlSourceNeedPerKind,
} from './wl-seeder.js';
import { WL_ROUND_ORDER, type WlRoundKind } from './wl-rules.js';
import type {
  WlContentBatch,
  WlContentCheckResponse,
  WlContentImportRequest,
  WlContentQuestion,
  WlContentRowReport,
} from './wl-content.schemas.js';

/** Category every WL pool question lives in (the manual ingests used it too). */
export const WL_CONTENT_CATEGORY_SLUG = 'world-cup';

const IMAGE_PROBE_TIMEOUT_MS = 30_000;
const IMAGE_PROBE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_PROBE_CONCURRENCY = 4;
const IMAGE_PROBE_MAX_REDIRECTS = 3;
const IMAGE_MIN_WIDTH = 300;
/** A batch nobody is processing for this long is declared interrupted (server restart). */
const BATCH_STALE_MS = 30 * 60 * 1000;

const en = (f: unknown): string => (typeof f === 'string' ? f : ((f as I18nField | null)?.['en'] ?? ''));

function storagePublicBase(): string {
  const base = (config.SUPABASE_URL ?? '').replace(/\/$/, '');
  return base ? `${base}/storage/v1/object/public/` : '';
}

// ─── History / pool index ─────────────────────────────────────────────────────

interface KeyHit { question_id: string | null; where: 'pool' | 'public' | 'history'; played: boolean; week_key: string | null; status: string | null }

interface ContentIndex {
  exact: Map<string, KeyHit>;
  loose: Map<string, KeyHit>;
}

function remember(map: Map<string, KeyHit>, key: string | null, hit: KeyHit): void {
  if (!key) return;
  const prev = map.get(key);
  // Played beats dealt beats protected pool beats public bank (strongest proof of exposure wins).
  const rank = (h: KeyHit) => (h.played ? 3 : h.where === 'history' ? 2 : h.where === 'pool' ? 1 : 0);
  if (!prev || rank(hit) > rank(prev)) map.set(key, hit);
}

/** Minimal payload carrying only what the content keys look at (keeps 25 MB of JSON out of the query). */
function slimPayload(row: { type: string; answer_en: string | null; items_en: string[] | null; correct_en: string | null }): Record<string, unknown> {
  return {
    display_answer: row.answer_en != null ? { en: row.answer_en } : undefined,
    items: row.items_en ? row.items_en.map((label, i) => ({ label: { en: label }, sort_value: i + 1 })) : undefined,
    options: row.type === 'mcq_single' ? [{ text: { en: row.correct_en ?? '' }, is_correct: true }] : undefined,
  };
}

const CONTENT_INDEX_TTL_MS = 5 * 60 * 1000;
const contentIndexCache = new Map<string, { builtAt: number; index: ContentIndex }>();
/** Call after anything this service publishes or deletes; other CMS edits age out within the TTL. */
export function invalidateContentIndex(): void { contentIndexCache.clear(); }

async function loadContentIndex(types: readonly string[], opts: { fresh?: boolean; excludeIds?: readonly string[]; db?: typeof sql } = {}): Promise<ContentIndex> {
  // A caller inside a transaction passes its own connection: the transaction must never sit idle
  // while this runs elsewhere (the pooler role kills idle-in-transaction sessions after 15 s).
  const db = opts.db ?? sql;
  const exclude = [...(opts.excludeIds ?? []), '00000000-0000-0000-0000-000000000000'];
  const cacheable = !opts.excludeIds?.length;
  const cacheKey = [...types].sort().join(',');
  const cached = contentIndexCache.get(cacheKey);
  if (cacheable && cached && !opts.fresh && Date.now() - cached.builtAt < CONTENT_INDEX_TTL_MS) return cached.index;

  const index: ContentIndex = { exact: new Map(), loose: new Map() };
  // Keys are extracted in SQL (prompt, answer, ordered item labels, correct
  // option) instead of shipping every payload: 3.3 s → ~1 s on staging, and
  // the result is cached for the interactive check.
  const pool = await db<Array<{ id: string; type: string; status: string; visibility: string; prompt_en: string | null; answer_en: string | null; items_en: string[] | null; correct_en: string | null }>>`
    SELECT q.id, q.type, q.status, q.visibility,
           q.prompt->>'en' AS prompt_en,
           qp.payload->'display_answer'->>'en' AS answer_en,
           CASE WHEN q.type = 'put_in_order' THEN
             (SELECT jsonb_agg(i->'label'->>'en' ORDER BY (i->>'sort_value')::numeric) FROM jsonb_array_elements(qp.payload->'items') i)
           END AS items_en,
           CASE WHEN q.type = 'mcq_single' THEN
             (SELECT o->'text'->>'en' FROM jsonb_array_elements(qp.payload->'options') o WHERE (o->>'is_correct')::bool LIMIT 1)
           END AS correct_en
    FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
    WHERE q.type = ANY(${sql.array([...types])})
      AND (q.visibility = 'wl_private' OR (q.visibility = 'public' AND q.status = 'published'))
      AND NOT (q.id = ANY(${sql.array(exclude)}::uuid[]))
  `;
  for (const row of pool) {
    const keys = contentKeysOf(row.type, row.prompt_en, slimPayload(row));
    const hit: KeyHit = { question_id: row.id, where: row.visibility === 'public' ? 'public' : 'pool', played: false, week_key: null, status: row.status };
    remember(index.exact, keys.exact, hit);
    remember(index.loose, keys.loose, hit);
  }
  const kinds = Object.entries(WL_KIND_TO_TYPE).filter(([, t]) => types.includes(t)).map(([k]) => k);
  const history = await db<Array<{ kind: string; source_question_id: string | null; week_key: string; played: boolean; prompt_en: string | null; answer_en: string | null; items_en: string[] | null; correct_en: string | null }>>`
    SELECT w.kind, w.source_question_id, t.week_key::text AS week_key, (pr.question_id IS NOT NULL) AS played,
           w.payload->'prompt'->>'en' AS prompt_en,
           w.evaluation->'display_answer'->>'en' AS answer_en,
           CASE WHEN w.kind = 'put_in_order' THEN
             (SELECT jsonb_agg(i->'label'->>'en' ORDER BY array_position(ARRAY(SELECT jsonb_array_elements_text(w.evaluation->'order')), i->>'id'))
              FROM jsonb_array_elements(w.payload->'items') i)
           END AS items_en,
           CASE WHEN w.kind IN ('mcq', 'money_drop') THEN
             (SELECT o->'text'->>'en' FROM jsonb_array_elements(w.payload->'options') o WHERE o->>'id' = w.evaluation->>'correct_id' LIMIT 1)
           END AS correct_en
    FROM wl_questions w
    JOIN wl_tournaments t ON t.id = w.tournament_id
    LEFT JOIN (SELECT DISTINCT question_id, tournament_id FROM wl_question_runs WHERE status <> 'voided') pr
      ON pr.question_id = w.question_id AND pr.tournament_id = w.tournament_id
    WHERE t.is_test = false AND w.kind = ANY(${sql.array(kinds)})
  `;
  for (const row of history) {
    const type = WL_KIND_TO_TYPE[row.kind]!;
    const keys = contentKeysOf(type, row.prompt_en, slimPayload({ ...row, type }));
    const hit: KeyHit = { question_id: row.source_question_id, where: 'history', played: row.played, week_key: row.week_key, status: null };
    remember(index.exact, keys.exact, hit);
    remember(index.loose, keys.loose, hit);
  }
  if (cacheable) contentIndexCache.set(cacheKey, { builtAt: Date.now(), index });
  return index;
}

// ─── Image probe (SSRF-safe, size-bounded) ────────────────────────────────────

export interface ImageProbe { ok: boolean; url: string; width: number | null; height: number | null; bytes: number | null; content_type: string | null; reason: string | null }
interface ProbeResult { probe: ImageProbe; buffer: Buffer | null; final_url: string | null }

/** Resolve the host and refuse anything that is not a public internet address; returns the vetted addresses. */
async function resolvePublicHost(url: URL): Promise<Array<{ address: string; family: number }>> {
  if (!/^https?:$/.test(url.protocol)) throw new Error('only http(s) URLs');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isForbiddenHostname(host)) throw new Error('host not allowed');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true }).then((r) => r.map((a) => ({ address: a.address, family: a.family }))).catch(() => []);
  if (!addresses.length) throw new Error('host does not resolve');
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error('host not allowed');
  return addresses;
}

interface SafeResponse { status: number; headers: Record<string, string>; body: Buffer | null; overLimit: boolean; finalUrl: string }

/**
 * GET with the connection pinned to the address we validated (no second DNS
 * lookup → no rebinding), manual redirects (each hop re-validated), a hard
 * byte cap enforced while streaming, and one deadline for the whole thing.
 */
async function fetchImageSafely(url: string, limit: number, deadlineMs: number): Promise<SafeResponse> {
  // One wall-clock deadline for DNS + every redirect hop + body streaming. A
  // socket idle timeout alone would let a trickling server hold the import
  // queue forever; on expiry the live request is destroyed.
  let active: http.ClientRequest | null = null;
  let expired = false;
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => { expired = true; active?.destroy(new Error('deadline')); reject(new Error(`timed out after ${deadlineMs / 1000}s`)); }, deadlineMs).unref();
  });
  const work = (async (): Promise<SafeResponse> => {
    let current = new URL(url);
    for (let hop = 0; hop <= IMAGE_PROBE_MAX_REDIRECTS; hop += 1) {
      const addresses = await resolvePublicHost(current);
      if (expired) throw new Error(`timed out after ${deadlineMs / 1000}s`);
      const pinned = addresses[0]!;
      const res = await new Promise<SafeResponse>((resolve, reject) => {
        const mod = current.protocol === 'https:' ? https : http;
        const req = mod.request(current, {
          method: 'GET',
          timeout: deadlineMs,
          // Pin the socket to the vetted address; TLS SNI/verification still use the hostname.
          lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
            // Newer Node resolves with { all: true } (happy eyeballs) — answer in whichever shape was asked for.
            if (opts?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
            else cb(null, pinned.address, pinned.family);
          }) as unknown as import('node:net').LookupFunction,
          headers: {
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 QuizballCMS/1.0',
            accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            referer: `${current.protocol}//${current.host}/`,
          },
        }, (r) => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(r.headers)) if (typeof v === 'string') headers[k] = v;
          const status = r.statusCode ?? 0;
          if (status >= 300 && status < 400) { r.resume(); resolve({ status, headers, body: null, overLimit: false, finalUrl: current.toString() }); return; }
          const chunks: Buffer[] = []; let total = 0; let over = false;
          r.on('data', (chunk: Buffer) => {
            if (over) return;
            total += chunk.length;
            if (total > limit) { over = true; req.destroy(); resolve({ status, headers, body: null, overLimit: true, finalUrl: current.toString() }); return; }
            chunks.push(chunk);
          });
          r.on('end', () => { if (!over) resolve({ status, headers, body: Buffer.concat(chunks), overLimit: false, finalUrl: current.toString() }); });
          r.on('error', reject);
        });
        active = req;
        req.on('timeout', () => { req.destroy(new Error(`timed out after ${deadlineMs / 1000}s`)); });
        req.on('error', reject);
        req.end();
      });
      active = null;
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers['location'];
        if (!location) throw new Error(`redirect without location (HTTP ${res.status})`);
        current = new URL(location, current);
        continue;
      }
      return res;
    }
    throw new Error('too many redirects');
  })();
  return Promise.race([work, deadline]);
}

async function probeImageFull(url: string, opts: { keepBuffer: boolean }): Promise<ProbeResult> {
  const fail = (reason: string, extra: Partial<ImageProbe> = {}): ProbeResult =>
    ({ probe: { ok: false, url, width: null, height: null, bytes: null, content_type: null, reason, ...extra }, buffer: null, final_url: null });
  try { new URL(url); } catch { return fail('not a valid URL'); }
  let res: SafeResponse;
  try {
    res = await fetchImageSafely(url, IMAGE_PROBE_MAX_BYTES, IMAGE_PROBE_TIMEOUT_MS);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const contentType = res.headers['content-type'] ?? null;
  if (res.status < 200 || res.status >= 300) return fail(`HTTP ${res.status} — the host refuses us; download it and re-host, or pick another image`, { content_type: contentType });
  if (res.overLimit || !res.body) return fail('image larger than 20MB', { content_type: contentType });
  const buf = res.body;
  let meta: sharp.Metadata;
  try { meta = await sharp(buf).metadata(); } catch { return fail('URL does not return a decodable image (a web page?)', { bytes: buf.byteLength, content_type: contentType }); }
  const width = meta.width ?? null; const height = meta.height ?? null;
  const probe: ImageProbe = { ok: true, url, width, height, bytes: buf.byteLength, content_type: contentType ?? (meta.format ? `image/${meta.format}` : null), reason: null };
  if (!width || !height) return { probe: { ...probe, ok: false, reason: 'could not read image dimensions' }, buffer: null, final_url: null };
  if (width < IMAGE_MIN_WIDTH) return { probe: { ...probe, ok: false, reason: `too small (${width}px wide, need ≥ ${IMAGE_MIN_WIDTH})` }, buffer: null, final_url: null };
  const aspect = width / height;
  if (aspect < 0.4 || aspect > 3) return { probe: { ...probe, ok: false, reason: `unusual aspect ratio ${aspect.toFixed(2)} — will not fit the card` }, buffer: null, final_url: null };
  return { probe, buffer: opts.keepBuffer ? buf : null, final_url: res.finalUrl };
}

export async function probeImage(url: string): Promise<ImageProbe> {
  return (await probeImageFull(url, { keepBuffer: false })).probe;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

// ─── check ────────────────────────────────────────────────────────────────────

export function hasErrors(issues: WlShapeIssue[]): boolean { return issues.some((i) => i.severity === 'error'); }

/** Display status: a duplicate is shown as such even when it also has errors; eligibility looks at the issues. */
function rowStatus(issues: WlShapeIssue[], dupe: WlContentRowReport['duplicate_of'], similar: WlContentRowReport['similar_to'], crests: WlContentRowReport['crests']): WlContentRowReport['status'] {
  if (dupe?.played) return 'played';
  if (dupe) return 'duplicate';
  if (hasErrors(issues)) return 'error';
  if (issues.length || similar || crests.some((c) => !c.club_id)) return 'warning';
  return 'ready';
}

export function clientImageUrl(q: WlContentQuestion): string | null {
  const image = (q.payload as { image?: { url?: string } | null }).image;
  return image?.url ?? null;
}

/** A URL under our own public storage: no download needed, verified by HEAD at import. */
function isOurStorageUrl(url: string): boolean {
  const base = storagePublicBase();
  return Boolean(base) && url.startsWith(base);
}

export async function runChecks(questions: WlContentQuestion[], opts: { probeImages?: boolean; index?: ContentIndex; fresh?: boolean; excludeIds?: readonly string[]; db?: typeof sql }): Promise<{ report: WlContentCheckResponse; probes: Array<ProbeResult | null> }> {
  const types = [...new Set(questions.map((q) => q.type))];
  const index = opts.index ?? await loadContentIndex(types, { fresh: opts.fresh, excludeIds: opts.excludeIds, db: opts.db });
  const inBatchExact = new Map<string, number>();
  const inBatchLoose = new Map<string, number>();
  const rows: WlContentRowReport[] = [];
  // Every image URL — including ones already in our storage — is downloaded,
  // decoded and measured. Buffers are NOT kept: a 100-row file could hold 2 GB.
  const probes = await mapLimit(questions, IMAGE_PROBE_CONCURRENCY, (q) => {
    const url = clientImageUrl(q);
    if (q.type !== 'mcq_single' || !url || opts.probeImages === false) return Promise.resolve(null);
    return probeImageFull(url, { keepBuffer: false });
  });

  questions.forEach((q, index_) => {
    const payload = q.payload as unknown as Record<string, unknown>;
    const issues: WlShapeIssue[] = [];
    if (!(WL_CONTENT_KINDS as readonly string[]).includes(q.type)) {
      issues.push({ code: 'type', message: `${q.type} is not a Weekend League round type`, severity: 'error' });
    }
    issues.push(...wlShapeIssues(q.type, payload));
    if (!en(q.prompt).trim() && q.type !== 'career_path' && q.type !== 'clue_chain') {
      issues.push({ code: 'prompt', message: 'Missing question text', severity: 'error' });
    }

    const keys = contentKeysOf(q.type, q.prompt, payload);
    let duplicate_of: WlContentRowReport['duplicate_of'] = null;
    let similar_to: WlContentRowReport['similar_to'] = null;
    if (keys.exact) {
      const hit = index.exact.get(keys.exact);
      if (hit) duplicate_of = { question_id: hit.question_id, where: hit.where, played: hit.played, week_key: hit.week_key, status: hit.status };
      else if (inBatchExact.has(keys.exact)) {
        duplicate_of = { question_id: null, where: 'batch', played: false, week_key: null, status: null };
        issues.push({ code: 'batch_dupe', message: `Same as row ${inBatchExact.get(keys.exact)! + 1} of this file`, severity: 'warning' });
      } else inBatchExact.set(keys.exact, index_);
    }
    if (!duplicate_of && keys.loose && keys.loose !== keys.exact) {
      const hit = index.loose.get(keys.loose);
      if (hit) similar_to = { question_id: hit.question_id, where: hit.where, week_key: hit.week_key };
      else if (inBatchLoose.has(keys.loose) && inBatchLoose.get(keys.loose) !== index_) similar_to = { question_id: null, where: 'batch', week_key: null };
      else inBatchLoose.set(keys.loose, index_);
      if (similar_to) issues.push({ code: 'similar', message: q.type === 'mcq_single' ? 'Same question text was used before with a different answer' : 'Same four items were ranked before under a different criterion or order', severity: 'warning' });
    }

    const crests = q.type === 'career_path' ? resolveCrests(((payload['clubs'] as I18nField[] | undefined) ?? []).map((c) => en(c))) : [];
    for (const c of crests) if (!c.club_id) issues.push({ code: 'no_crest', message: `No crest for "${c.club}" — it will show as a blank badge`, severity: 'warning' });

    const image = probes[index_]?.probe ?? null;
    // Image problems are ALWAYS errors — a duplicate verdict changes how the row is shown, never whether a bad photo may be forced through.
    if (image && !image.ok) issues.push({ code: 'image', message: `Image: ${image.reason}`, severity: 'error' });

    rows.push({ index: index_, type: q.type, status: rowStatus(issues, duplicate_of, similar_to, crests), issues, duplicate_of, similar_to, crests, image });
  });

  const summary = { ready: 0, warning: 0, duplicate: 0, played: 0, error: 0 };
  for (const r of rows) summary[r.status] += 1;
  return { report: { rows, summary, staging_configured: Boolean(config.STAGING_DATABASE_URL) }, probes };
}

export async function wlContentCheck(questions: WlContentQuestion[], opts: { probeImages?: boolean; index?: ContentIndex; fresh?: boolean } = {}): Promise<WlContentCheckResponse> {
  return (await runChecks(questions, opts)).report;
}

// ─── import ───────────────────────────────────────────────────────────────────

/** Imports run one at a time in this process; the set knows which batches are truly alive. */
let importChain: Promise<unknown> = Promise.resolve();
const runningBatches = new Set<string>();

/** Run background work for a batch on the process-wide import queue (imports, lineup saves, photo cleanups). */
export function enqueueBatchJob(batchId: string, job: () => Promise<void>, onCrash: (err: unknown) => Promise<void>): void {
  runningBatches.add(batchId);
  startImportLease();
  importChain = importChain
    .then(job)
    .catch(async (err) => { logger.error({ err, batchId }, 'WL content batch job crashed'); await onCrash(err).catch(() => {}); })
    .finally(() => runningBatches.delete(batchId));
}

export class BatchClosedError extends Error {}

/**
 * Every write transaction of an import holds the batch row FOR SHARE and
 * requires 'processing': once reconciliation or anything else closes the
 * batch (which needs the row lock), a stalled worker cannot create or
 * publish another question — so an undo's photo candidates stay ownerless.
 */
export async function assertBatchLive(x: typeof sql, batchId: string): Promise<void> {
  const [b] = await x<Array<{ status: string }>>`SELECT status FROM wl_content_batches WHERE id = ${batchId} FOR SHARE`;
  if (b?.status !== 'processing') throw new BatchClosedError(`batch is ${b?.status ?? 'missing'}; import stopped`);
}

/** Renewable lease: every batch alive in this process (queued or running) keeps its updated_at fresh. */
let leaseTimer: NodeJS.Timeout | null = null;
function startImportLease(): void {
  if (leaseTimer) return;
  leaseTimer = setInterval(() => {
    if (!runningBatches.size) return;
    sql`UPDATE wl_content_batches SET updated_at = NOW() WHERE id = ANY(${sql.array([...runningBatches])}::uuid[]) AND status = 'processing'`
      .catch((err) => logger.warn({ err }, 'WL content: import lease refresh failed'));
  }, 5 * 60_000);
  leaseTimer.unref();
}

export async function wlCategory(): Promise<{ id: string; slug: string }> {
  const [cat] = await sql<Array<{ id: string; slug: string }>>`SELECT id, slug FROM categories WHERE slug = ${WL_CONTENT_CATEGORY_SLUG}`;
  if (!cat) throw new BadRequestError(`WL category '${WL_CONTENT_CATEGORY_SLUG}' is missing`);
  return cat;
}

export function questionSummary(type: string, prompt: unknown, payload: Record<string, unknown> | null | undefined): string {
  const p = payload ?? {};
  if (type === 'career_path') return `${en(p['display_answer'])} — ${((p['clubs'] as I18nField[] | undefined) ?? []).map(en).join(' → ')}`;
  if (type === 'clue_chain') return en(p['display_answer']);
  return en(prompt);
}

/** Rows that may not be imported: any error issue (never forceable), or an unforced duplicate. */
function blockedRows(check: WlContentCheckResponse, forced: Set<number>): WlContentRowReport[] {
  return check.rows.filter((r) => hasErrors(r.issues) || ((r.status === 'duplicate' || r.status === 'played') && !forced.has(r.index)));
}

/**
 * Validates (fast, for the 400), records the batch with one row per
 * question, and returns immediately; the heavy lifting continues in the
 * background under a process-wide queue and is observable through the batch.
 */
export async function wlContentImport(input: WlContentImportRequest, actor: { id?: string; email?: string }): Promise<{ batch_id: string; accepted: number }> {
  const check = await wlContentCheck(input.questions, { probeImages: false });
  const forced = new Set(input.force_indexes);
  const blocked = blockedRows(check, forced);
  if (blocked.length) throw new BadRequestError(`${blocked.length} row(s) cannot be published as-is`, { rows: blocked });
  const category = await wlCategory();
  const batchId = await sql.begin(async (tx) => {
    const x = tx as unknown as typeof sql;
    const [batch] = await x<Array<{ id: string }>>`
      INSERT INTO wl_content_batches (created_by, kind, note, status, row_count, sync_to_staging)
      VALUES (${actor.id ?? null}, ${input.kind}, ${input.note ?? null}, 'processing', ${input.questions.length}, ${input.sync_to_staging})
      RETURNING id
    `;
    for (const [index, q] of input.questions.entries()) {
      await x`INSERT INTO wl_content_batch_rows (batch_id, row_index, summary, state)
              VALUES (${batch!.id}, ${index}, ${questionSummary(q.type, q.prompt, q.payload as unknown as Record<string, unknown>).slice(0, 300)}, 'pending')`;
    }
    return batch!.id;
  });
  runningBatches.add(batchId);
  startImportLease();
  importChain = importChain
    .then(() => runImport(batchId, input, forced, category, actor))
    .catch(async (err) => {
      logger.error({ err, batchId }, 'WL content import crashed');
      await sql`UPDATE wl_content_batches SET status = 'failed', error = ${`import crashed: ${err instanceof Error ? err.message : String(err)}`}, updated_at = NOW() WHERE id = ${batchId} AND status = 'processing'`.catch(() => {});
    })
    .finally(() => runningBatches.delete(batchId));
  return { batch_id: batchId, accepted: input.questions.length };
}

/** Also the import's heartbeat: a batch whose updated_at stops moving is treated as interrupted. */
export async function setRow(batchId: string, rowIndex: number, patch: { state: string; error?: string | null; question_id?: string }): Promise<void> {
  await sql`UPDATE wl_content_batches SET updated_at = NOW() WHERE id = ${batchId}`;
  await sql`
    UPDATE wl_content_batch_rows
    SET state = ${patch.state}, error = ${patch.error ?? null},
        question_id = COALESCE(${patch.question_id ?? null}::uuid, question_id)
    WHERE batch_id = ${batchId} AND row_index = ${rowIndex}
  `;
}

/** The object must live in OUR storage and answer HEAD as an image. */
export async function storedImageProblem(url: string | undefined | null): Promise<string | null> {
  if (!url) return 'no image url';
  if (!isOurStorageUrl(url)) return 'photo is not hosted in our storage';
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return `stored photo returned HTTP ${res.status}`;
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return `stored object is ${type || 'not an image'}`;
    return null;
  } catch (err) {
    return `could not verify stored photo: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Turn the client's image block into a server-owned one: download the URL
 * again through the pinned, bounded fetcher (one row at a time, so memory is
 * one image), decode and measure it, normalize and upload it to OUR storage,
 * then HEAD-verify the object. Applies to URLs already in our storage too —
 * client-supplied storage_status / source_url / dimensions are never trusted.
 */
export async function hostImage(q: WlContentQuestion, categorySlug: string, ownedPrefix: string): Promise<Record<string, unknown>> {
  const client = (q.payload as { image?: Record<string, unknown> }).image ?? {};
  const url = clientImageUrl(q)!;
  const probed = await probeImageFull(url, { keepBuffer: true });
  if (!probed.probe.ok || !probed.buffer) throw new Error(`photo could not be used: ${probed.probe.reason ?? 'no image data'}`);
  const png = await normalizeImageToTransparentPng(probed.buffer, DEFAULT_QUESTION_IMAGE_WIDTH, DEFAULT_QUESTION_IMAGE_HEIGHT);
  const uploaded = await uploadQuestionImageBuffer(png, { categorySlug, width: DEFAULT_QUESTION_IMAGE_WIDTH, height: DEFAULT_QUESTION_IMAGE_HEIGHT, ownedPrefix });
  const problem = await storedImageProblem(uploaded.url);
  if (problem) throw new Error(problem);
  return {
    ...client, ...uploaded,
    // Never keep another import's owned URL as provenance: the photo-owner trigger would refuse the row.
    source_url: isWlImportOwnedImageUrl(probed.final_url ?? url) ? null : probed.final_url ?? url,
    storage_status: 'stored', storage_error: null, storage_attempted_at: new Date().toISOString(), provider: PHOTO_PROVIDER,
  };
}

async function runImport(batchId: string, input: WlContentImportRequest, forced: Set<number>, category: { id: string; slug: string }, actor: { id?: string; email?: string }): Promise<void> {
  // Fence: a batch that another replica closed (or someone undid) while it waited in this queue never runs.
  const [live] = await sql<Array<{ id: string }>>`UPDATE wl_content_batches SET updated_at = NOW() WHERE id = ${batchId} AND status = 'processing' RETURNING id`;
  if (!live) { logger.warn({ batchId }, 'WL content import skipped: batch is no longer processing'); return; }
  // Authoritative decision happens HERE, inside the queue: another import may
  // have landed between the request's check and our turn. Photos are probed
  // (and downloaded) here too — those bytes are what we upload.
  const [{ at: recheckStartedAt }] = await sql<Array<{ at: string }>>`SELECT NOW()::text AS at`;
  const { report: recheck } = await runChecks(input.questions, { probeImages: true, fresh: true });
  const created: Array<{ index: number; id: string }> = [];
  const failures: Array<{ index: number; error: string }> = [];
  const fail = async (index: number, error: string) => { failures.push({ index, error }); await setRow(batchId, index, { state: 'failed', error }); };

  // 1. Insert drafts, each linked to its batch row in the same transaction.
  for (const [index, q] of input.questions.entries()) {
    const report = recheck.rows[index]!;
    if (hasErrors(report.issues)) { await fail(index, report.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ')); continue; }
    if ((report.status === 'duplicate' || report.status === 'played') && !forced.has(index)) {
      await fail(index, `became a duplicate while waiting (${report.duplicate_of?.where === 'batch' ? 'another row in this file' : `already ${report.duplicate_of?.played ? 'played' : 'in the pool'}`})`);
      continue;
    }
    try {
      let payload = q.payload as unknown as Record<string, unknown>;
      if (q.type === 'mcq_single' && clientImageUrl(q)) {
        payload = { ...payload, image: await hostImage(q, category.slug, `${batchId}/${index}`) };
      }
      const normalized = normalizePayload(payload as Json, `wl import row ${index}`);
      const id = await sql.begin(async (tx) => {
        const x = tx as unknown as typeof sql;
        await assertBatchLive(x, batchId);
        const [row] = await x<Array<{ id: string }>>`
          INSERT INTO questions (category_id, type, difficulty, status, ranked_eligible, visibility, prompt, explanation, created_by)
          VALUES (${category.id}, ${q.type}, ${q.difficulty}, 'draft', false, 'wl_private', ${sql.json(q.prompt as never)},
                  ${q.explanation ? sql.json(q.explanation as never) : null}, ${actor.id ?? null})
          RETURNING id
        `;
        // Row link first: the photo-owner trigger on question_payloads checks it.
        await x`UPDATE wl_content_batch_rows SET question_id = ${row!.id}, state = 'created' WHERE batch_id = ${batchId} AND row_index = ${index}`;
        await x`INSERT INTO question_payloads (question_id, payload) VALUES (${row!.id}, ${sql.json(normalized as never)})`;
        await x`UPDATE wl_content_batches SET updated_at = NOW() WHERE id = ${batchId}`;
        return row!.id;
      });
      created.push({ index, id });
    } catch (err) {
      if (err instanceof BatchClosedError) throw err;
      await fail(index, err instanceof Error ? err.message : String(err));
    }
  }

  // 2. Georgian for everything at once (idempotent; each row is re-read under lock below).
  const ids = created.map((c) => c.id);
  if (ids.length) {
    try {
      await translationService.translateQuestions(ids);
    } catch (err) {
      logger.error({ err, batchId }, 'WL content translation batch failed');
    }
  }

  // 3. Per row, in one transaction with the rows locked: WL shape + hosted
  //    photo + bilingual → expand aliases → publish validation → publish with
  //    visibility forced back to wl_private. A concurrent CMS edit cannot slip
  //    between the validated snapshot and the status flip.
  const published: string[] = [];
  for (const { index, id } of created) {
    try {
      await sql.begin(async (tx) => {
        const x = tx as unknown as typeof sql;
        await assertBatchLive(x, batchId);
        // Publication is serialized with lineup saves, whose final duplicate check runs under this lock.
        await wlLockContentAllocation(x);
        const [row] = await x<Array<{ type: string; prompt: I18nField; explanation: unknown; payload: Record<string, unknown> | null }>>`
          SELECT q.type, q.prompt, q.explanation, qp.payload
          FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
          WHERE q.id = ${id} FOR UPDATE OF q, qp
        `;
        if (!row) throw new Error('row vanished after insert');
        // The recheck above saw everything published before it started; under the lock, compare
        // with what was published since (another batch or a lineup save) so no twin slips through.
        if (!forced.has(index)) {
          const mine = contentKeysOf(row.type, row.prompt, row.payload ?? {}).exact;
          const since = mine ? await x<Array<{ prompt: I18nField; payload: Record<string, unknown> }>>`
            SELECT q.prompt, qp.payload FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
            WHERE q.type = ${row.type} AND q.status = 'published' AND q.updated_at >= ${recheckStartedAt}::timestamptz
              AND NOT (q.id = ANY(${x.array(created.map((c) => c.id))}::uuid[]))` : [];
          if (since.some((o) => contentKeysOf(row.type, o.prompt, o.payload).exact === mine)) throw new Error('became a duplicate while publishing (the same question was just published elsewhere)');
        }
        let payload = row.payload ?? {};
        const shape = wlShapeIssues(row.type, payload).filter((i) => i.severity === 'error');
        if (shape.length) throw new Error(shape.map((i) => i.message).join('; '));
        if (row.type === 'mcq_single') {
          const image = payload['image'] as { url?: string } | null | undefined;
          // The editor submitted a photo → the row must still carry a hosted one at publish time.
          if (clientImageUrl(input.questions[index]!) && !image?.url) throw new Error('photo was removed before publish — re-upload the question');
          if (image?.url) {
            const problem = await storedImageProblem(image.url);
            if (problem) throw new Error(problem);
          }
        }
        if (!payloadFullyBilingual(row.prompt, payload)) {
          throw new Error('Georgian translation incomplete — open the question in the CMS, fill KA, then publish');
        }
        if (row.type === 'career_path' || row.type === 'clue_chain') {
          const accepted = expandAcceptedAnswers(payload['display_answer'] as I18nField, (payload['accepted_answers'] as string[] | undefined) ?? []);
          payload = { ...payload, accepted_answers: accepted };
          await x`UPDATE question_payloads SET payload = ${sql.json(payload as never)}, updated_at = NOW() WHERE question_id = ${id}`;
        }
        assertPublishableContent({ id, type: row.type, prompt: row.prompt, explanation: row.explanation, payload });
        await x`UPDATE questions SET status = 'published', visibility = 'wl_private', ranked_eligible = false, updated_at = NOW() WHERE id = ${id}`;
        await x`UPDATE wl_content_batch_rows SET state = 'published', error = NULL WHERE batch_id = ${batchId} AND row_index = ${index}`;
        await x`UPDATE wl_content_batches SET updated_at = NOW() WHERE id = ${batchId}`;
      });
      published.push(id);
    } catch (err) {
      if (err instanceof BatchClosedError) throw err;
      await fail(index, err instanceof Error ? err.message : String(err));
    }
  }
  invalidateCategoryCache();
  invalidateContentIndex();

  // 4. Staging copy — a one-time copy of the published rows; reported, never fatal.
  let staging: unknown = null;
  if (input.sync_to_staging && published.length) {
    try {
      staging = await stagingSyncService.syncQuestions(published);
    } catch (err) {
      staging = { error: err instanceof Error ? err.message : String(err) };
      logger.error({ err, batchId }, 'WL content staging sync failed');
    }
  }

  // Photos uploaded for rows that failed before becoming questions (still 'processing', so no undo can interleave).
  const photoRowsFailed = failures.some((f) => input.questions[f.index]!.type === 'mcq_single' && clientImageUrl(input.questions[f.index]!));
  const photos = photoRowsFailed ? await deleteUnusedBatchPhotos(batchId) : null;
  const result = { created: created.length, published: published.length, failed: failures.length, failures, staging, photos, photos_pending: Boolean(photos?.error) };
  await sql`
    UPDATE wl_content_batches
    SET status = ${published.length || !failures.length ? 'done' : 'failed'}, result = ${sql.json(result as never)}, updated_at = NOW(),
        error = ${failures.length && !published.length ? 'no row could be published' : null}
    WHERE id = ${batchId} AND status = 'processing'
  `;
  logger.info({ batchId, actor: actor.email ?? actor.id, created: created.length, published: published.length, failed: failures.length }, 'WL content batch finished');
}

const sweepsQueued = new Set<string>();

/** An import whose leftover-photo sweep failed retries it on the queue (the published rows stay). */
async function retryImportSweeps(): Promise<void> {
  const due = await sql<Array<{ id: string }>>`
    SELECT id FROM wl_content_batches WHERE status IN ('done', 'failed') AND result->>'photos_pending' = 'true' LIMIT 20`;
  for (const { id } of due) {
    if (sweepsQueued.has(id)) continue;
    sweepsQueued.add(id);
    const run = importChain.then(async () => {
      const outcome = await deleteUnusedBatchPhotos(id);
      await sql`UPDATE wl_content_batches SET result = result || ${sql.json({ photos: { ...outcome, at: new Date().toISOString() }, photos_pending: Boolean(outcome.error) } as never)}
                WHERE id = ${id} AND status IN ('done', 'failed')`;
    }).finally(() => sweepsQueued.delete(id));
    importChain = run.catch(() => {});
  }
}

/** Batches left 'processing' by a restart are closed as failed so they can be undone. */
async function reconcileInterruptedBatches(): Promise<void> {
  await retryImportSweeps();
  // One conditional transition: a lease refreshed after we looked keeps its batch alive.
  const alive = sql.array([...runningBatches, '00000000-0000-0000-0000-000000000000']);
  // A lineup publishes only in its final transaction, so an interrupted one holds drafts only:
  // close it and delete them in ONE transaction; the photo sweep (photos_pending) removes their uploads.
  const staleLineups = await sql<Array<{ id: string }>>`
    SELECT id FROM wl_content_batches
    WHERE kind = 'lineup' AND status = 'processing' AND updated_at < NOW() - make_interval(secs => ${BATCH_STALE_MS / 1000})
      AND NOT (id = ANY(${alive}::uuid[]))`;
  for (const { id } of staleLineups) {
    await sql.begin(async (tx) => {
      const x = tx as unknown as typeof sql;
      const [closed] = await x<Array<{ id: string }>>`
        UPDATE wl_content_batches
        SET status = 'failed', updated_at = NOW(), error = 'Nothing was scheduled: saving was interrupted (server restart) — preview again',
            result = coalesce(result, '{}'::jsonb) || '{"photos_pending": true}'::jsonb
        WHERE id = ${id} AND status = 'processing' AND updated_at < NOW() - make_interval(secs => ${BATCH_STALE_MS / 1000})
        RETURNING id`;
      if (!closed) return;
      await x`DELETE FROM questions q USING wl_content_batch_rows r WHERE r.batch_id = ${id} AND r.question_id = q.id AND q.status = 'draft'`;
      await x`UPDATE wl_content_batch_rows SET state = 'deleted' WHERE batch_id = ${id} AND state <> 'failed'`;
    });
    logger.warn({ batchId: id }, 'WL lineup save reconciled as interrupted — drafts removed');
  }
  const stale = await sql<Array<{ id: string; kind: string }>>`
    UPDATE wl_content_batches
    SET status = 'failed', updated_at = NOW(),
        error = 'import interrupted (server restart) — rows that reached "published" are live; undo removes the rest'
    WHERE kind <> 'lineup' AND status = 'processing' AND updated_at < NOW() - make_interval(secs => ${BATCH_STALE_MS / 1000})
      AND NOT (id = ANY(${alive}::uuid[]))
    RETURNING id, kind
  `;
  await sql`UPDATE wl_content_batches SET status = 'failed', error = coalesce(error, 'undo interrupted — run undo again'), updated_at = NOW(),
            result = coalesce(result, '{}'::jsonb) - 'undo_claim'
            WHERE status = 'undoing' AND updated_at < NOW() - interval '10 minutes'`;
  for (const { id } of stale) {
    await sql`UPDATE wl_content_batch_rows SET state = 'failed', error = 'import interrupted (server restart)' WHERE batch_id = ${id} AND state IN ('pending', 'created', 'translated')`;
    logger.warn({ batchId: id }, 'WL content batch reconciled as interrupted');
  }
}

// ─── batches ──────────────────────────────────────────────────────────────────

const batchSelect = sql`
  SELECT b.id, b.created_at, b.created_by, u.email AS created_by_email, b.kind, b.note, b.status, b.row_count,
         b.sync_to_staging, b.result, b.error, b.undone_at,
         json_build_object(
           'pending',    (SELECT count(*)::int FROM wl_content_batch_rows r WHERE r.batch_id = b.id AND r.state = 'pending'),
           'created',    (SELECT count(*)::int FROM wl_content_batch_rows r WHERE r.batch_id = b.id AND r.state = 'created'),
           'translated', (SELECT count(*)::int FROM wl_content_batch_rows r WHERE r.batch_id = b.id AND r.state = 'translated'),
           'published',  (SELECT count(*)::int FROM wl_content_batch_rows r WHERE r.batch_id = b.id AND r.state = 'published'),
           'failed',     (SELECT count(*)::int FROM wl_content_batch_rows r WHERE r.batch_id = b.id AND r.state = 'failed'),
           'deleted',    (SELECT count(*)::int FROM wl_content_batch_rows r WHERE r.batch_id = b.id AND r.state = 'deleted')
         ) AS counts
  FROM wl_content_batches b LEFT JOIN users u ON u.id = b.created_by
`;

export async function wlContentBatches(limit = 50): Promise<WlContentBatch[]> {
  await reconcileInterruptedBatches();
  return sql<WlContentBatch[]>`${batchSelect} ORDER BY b.created_at DESC LIMIT ${limit}`;
}

export interface WlPlacement { week_key: string; status: string; game_index: number; round_index: number | null; question_index: number | null; reserve_ordinal: number; kind: string }
export interface WlContentBatchRowView { row_index: number; question_id: string | null; state: string; error: string | null; summary: string; placements: WlPlacement[]; in_backup: boolean }
export interface WlLineupPlacementView {
  tournament_id: string; week_key: string; games: number[]; at: string;
  slots: Array<{ game_index: number; round_index: number | null; question_index: number | null; reserve_ordinal: number; kind: string; origin: 'upload' | 'pool'; source_question_id: string; summary: string; current: boolean }>;
}

export async function wlContentBatch(id: string): Promise<WlContentBatch & { rows: WlContentBatchRowView[]; lineup: WlLineupPlacementView | null }> {
  await reconcileInterruptedBatches();
  const [batch] = await sql<WlContentBatch[]>`${batchSelect} WHERE b.id = ${id}`;
  if (!batch) throw new NotFoundError('Batch not found');
  // Where each question is dealt: one indexed lookup on wl_questions.source_question_id for the whole batch.
  const rows = await sql<WlContentBatchRowView[]>`
    SELECT r.row_index, r.question_id, r.state, r.error, r.summary,
           coalesce((
             SELECT json_agg(json_build_object('week_key', t.week_key::text, 'status', t.status, 'game_index', w.game_index,
                                               'round_index', w.round_index, 'question_index', w.question_index,
                                               'reserve_ordinal', w.reserve_ordinal, 'kind', w.kind)
                             ORDER BY t.week_key DESC, w.game_index, w.reserve_ordinal, w.round_index, w.question_index)
             FROM wl_questions w JOIN wl_tournaments t ON t.id = w.tournament_id
             WHERE w.source_question_id = r.question_id AND t.is_test = false AND t.status <> 'cancelled'
           ), '[]'::json) AS placements,
           (r.question_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM wl_content_reseeds rs, jsonb_array_elements(rs.previous_rows) prev
             WHERE prev->>'source_question_id' = r.question_id::text)) AS in_backup
    FROM wl_content_batch_rows r WHERE r.batch_id = ${id} ORDER BY r.row_index
  `;
  return { ...batch, rows, lineup: batch.kind === 'lineup' ? await lineupPlacementView(batch.result) : null };
}

/** The exact slots a lineup batch saved, each marked whether the weekend still holds it there. */
async function lineupPlacementView(result: Record<string, unknown> | null): Promise<WlLineupPlacementView | null> {
  const placement = result?.['placement'] as (Omit<WlLineupPlacementView, 'slots'> & { slots: Array<Omit<WlLineupPlacementView['slots'][number], 'summary' | 'current'>> }) | undefined;
  if (!placement) return null;
  const ids = placement.slots.map((sl) => sl.source_question_id);
  const [current, sources] = await Promise.all([
    sql<Array<{ game_index: number; round_index: number | null; question_index: number | null; reserve_ordinal: number; kind: string; source_question_id: string }>>`
      SELECT game_index, round_index, question_index, reserve_ordinal, kind, source_question_id FROM wl_questions
      WHERE tournament_id = ${placement.tournament_id} AND source_question_id = ANY(${sql.array(ids)}::uuid[])`,
    sql<Array<{ id: string; type: string; prompt: unknown; payload: Record<string, unknown> | null }>>`
      SELECT q.id, q.type, q.prompt, qp.payload FROM questions q LEFT JOIN question_payloads qp ON qp.question_id = q.id WHERE q.id = ANY(${sql.array(ids)}::uuid[])`,
  ]);
  const key = (x: { game_index: number; round_index: number | null; question_index: number | null; reserve_ordinal: number; kind: string; source_question_id: string }) =>
    `${x.game_index}|${x.round_index}|${x.question_index}|${x.reserve_ordinal}|${x.kind}|${x.source_question_id}`;
  const now = new Set(current.map(key));
  const byId = new Map(sources.map((q) => [q.id, q]));
  return {
    tournament_id: placement.tournament_id, week_key: placement.week_key, games: placement.games, at: placement.at,
    slots: placement.slots.map((sl) => {
      const q = byId.get(sl.source_question_id);
      return { ...sl, summary: q ? questionSummary(q.type, q.prompt, q.payload) : '(question deleted)', current: now.has(key(sl)) };
    }),
  };
}

type Db = typeof sql;

/** Run against the staging database (null when no staging copy is configured). */
async function withStagingDb<T>(fn: (db: Db, hasReseeds: boolean) => Promise<T>): Promise<T | null> {
  if (!config.STAGING_DATABASE_URL) return null;
  const { default: postgres } = await import('postgres');
  const target = postgres(config.STAGING_DATABASE_URL, { ssl: 'require', max: 1, connect_timeout: 20, idle_timeout: 5, prepare: false, onnotice: () => {} });
  try {
    const [r] = await target<Array<{ ok: boolean }>>`SELECT to_regclass('public.wl_content_reseeds') IS NOT NULL AS ok`;
    return await fn(target as unknown as Db, Boolean(r?.ok));
  } finally { await target.end({ timeout: 5 }); }
}

/** Delete on staging the given ids that no staging tournament or reseed backup refers to; -1 = failed. */
async function stagingDelete(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  // Prod questions may have been copied to staging; without a connection that cannot be undone yet.
  if (!config.STAGING_DATABASE_URL) return config.NODE_ENV === 'prod' ? -1 : 0;
  try {
    const n = await withStagingDb(async (target, hasReseeds) => {
      const res = hasReseeds
        ? await target`
          DELETE FROM questions q WHERE q.id = ANY(${target.array(ids)}::uuid[])
            AND NOT EXISTS (SELECT 1 FROM wl_questions w WHERE w.source_question_id = q.id)
            AND NOT EXISTS (SELECT 1 FROM wl_content_reseeds rs, jsonb_array_elements(rs.previous_rows) prev WHERE prev->>'source_question_id' = q.id::text)`
        : await target`
          DELETE FROM questions q WHERE q.id = ANY(${target.array(ids)}::uuid[])
            AND NOT EXISTS (SELECT 1 FROM wl_questions w WHERE w.source_question_id = q.id)`;
      return res.count;
    });
    return n ?? 0;
  } catch (err) {
    logger.error({ err, ids }, 'WL content: staging delete failed — retry from the batch');
    return -1;
  }
}

// ─── photo cleanup ────────────────────────────────────────────────────────────

const PHOTO_PROVIDER = 'wl_content_import';

/**
 * Columns that can hold a copy of an imported photo's URL: the question's
 * payload, dealt WL rows and their event snapshots, reseed backups, content
 * release journals, campaign artwork (live + revisions). Nothing else can:
 * importer-owned objects are copied, never referenced, when saved on any other
 * question (ensureQuestionImageStored) and refused as campaign artwork.
 */
const PHOTO_REFERENCE_COLUMNS: ReadonlyArray<readonly [table: string, text: string]> = [
  ['question_payloads', 'x.payload::text'],
  ['wl_questions', 'x.payload::text'],
  ['wl_events', 'x.payload::text'],
  ['wl_content_reseeds', 'x.previous_rows::text'],
  ['question_release_rows', "coalesce(x.before_data::text, '') || x.after_data::text"],
  ['campaign_quizzes', 'x::text'],
  ['campaign_quiz_revisions', 'x::text'],
];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Which of these paths any reference row mentions — one query, literal folder prefilter (~1.3 s on staging). */
async function photoPathsInUse(db: Db, folder: string, paths: string[]): Promise<Set<string>> {
  const present = await db<Array<{ name: string }>>`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY(${db.array(PHOTO_REFERENCE_COLUMNS.map(([t]) => t))})`;
  const names = new Set(present.map((r) => r.name));
  const parts = PHOTO_REFERENCE_COLUMNS.filter(([t]) => names.has(t))
    .map(([t, text]) => `SELECT m[1] AS path FROM public.${t} x, regexp_matches(${text}, $1, 'g') m WHERE strpos(${text}, $2) > 0`);
  if (!parts.length) return new Set();
  const rows = await db.unsafe<Array<{ path: string }>>(parts.join('\nUNION\n'), [`(${paths.map(escapeRegex).join('|')})`, folder]);
  return new Set(rows.map((r) => r.path));
}

export interface PhotoCleanup { deleted: number; shared: number; error: string | null }

/**
 * Delete the photos in this batch's own storage folder that nothing uses.
 * Listing the folder (instead of remembering paths) also finds uploads whose
 * row failed, whose response was lost, or that a restart interrupted. Staging
 * copies of prod questions point at prod objects, so prod also checks staging
 * and, without a staging connection, deletes nothing.
 */
export async function deleteUnusedBatchPhotos(batchId: string): Promise<PhotoCleanup> {
  try {
    if (config.NODE_ENV === 'prod' && !config.STAGING_DATABASE_URL) {
      throw new Error('staging database is not configured, so staging copies cannot be checked — photos kept');
    }
    const folder = `${WL_IMPORT_PHOTO_DIR}/${batchId}`;
    // Only objects whose import row has no question (never created, or deleted by undo): the owner
    // trigger refuses to attach those anywhere, so nothing can start using one after the scan.
    const owned = await sql<Array<{ row_index: number }>>`
      SELECT row_index FROM wl_content_batch_rows WHERE batch_id = ${batchId} AND question_id IS NOT NULL`;
    const living = new Set(owned.map((r) => r.row_index));
    const paths = (await listStoredQuestionImages(folder)).filter((p) => {
      const row = /\/(\d+)-[^/]*$/.exec(p);
      return !row || !living.has(Number(row[1]));
    });
    if (!paths.length) return { deleted: 0, shared: 0, error: null };
    const prefix = `question-images/${folder}/`;
    const used = await photoPathsInUse(sql, prefix, paths);
    for (const p of (await withStagingDb((db) => photoPathsInUse(db, prefix, paths))) ?? []) used.add(p);
    const free = paths.filter((p) => !used.has(p));
    await removeStoredQuestionImages(free);
    return { deleted: free.length, shared: paths.length - free.length, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ err, batchId }, 'WL content: photo cleanup failed — retry from the batch');
    return { deleted: 0, shared: 0, error };
  }
}

/** Undo's photo step, on the import queue so it never overlaps an import of this process. */
function enqueueBatchPhotoCleanup(batchId: string): Promise<PhotoCleanup> {
  const run = importChain.then(async (): Promise<PhotoCleanup> => {
    const [b] = await sql<Array<{ staging: string[] | null }>>`
      SELECT result->'undo'->'staging_pending_ids' AS staging FROM wl_content_batches WHERE id = ${batchId}`;
    // Staging copies not yet deleted still point at these photos; they would read as "shared" and never be retried.
    const outcome = b?.staging?.length
      ? { deleted: 0, shared: 0, error: 'waiting for the staging cleanup to succeed' }
      : await deleteUnusedBatchPhotos(batchId);
    await sql`UPDATE wl_content_batches SET updated_at = NOW(),
              result = jsonb_set(jsonb_set(result, '{undo,photos_pending}', ${sql.json(Boolean(outcome.error) as never)}),
                                 '{undo,photos}', ${sql.json({ ...outcome, at: new Date().toISOString() } as never)})
              WHERE id = ${batchId}`;
    return outcome;
  });
  importChain = run.catch(() => {});
  return run;
}

/**
 * Delete the batch's questions that nothing refers to: not dealt into any
 * tournament and not held by a reseed backup (restoring that backup would
 * need the source row). Two locked phases around the external staging call:
 *   1. lock batch → verify status → read membership → mark 'undoing' (commit)
 *   2. staging delete (outside any transaction)
 *   3. lock batch → verify 'undoing' → delete rows + write bookkeeping (commit)
 * A concurrent undo sees 'undoing' and gets 409; a crash between phases leaves
 * 'undoing', which the next undo call resumes. Calling undo on an 'undone'
 * batch retries only the staging ids an earlier cleanup could not delete.
 */
export interface WlContentUndoResult {
  deleted: number; kept: number; kept_ids: string[]; staging_deleted: number | null;
  /** null = cleanup still queued behind a running import (the batch records the outcome). */
  photos: PhotoCleanup | null;
}

const PHOTO_WAIT_MS = 20_000;

async function awaitPhotoCleanup(id: string): Promise<PhotoCleanup | null> {
  const run = enqueueBatchPhotoCleanup(id);
  return Promise.race([run, new Promise<null>((resolve) => setTimeout(() => resolve(null), PHOTO_WAIT_MS).unref())]);
}

export async function wlContentUndoBatch(id: string, actor: string): Promise<WlContentUndoResult> {
  await reconcileInterruptedBatches();

  // Phase 1 — lock, decide, claim.
  const claim = await sql.begin(async (tx) => {
    const x = tx as unknown as typeof sql;
    const [batch] = await x<Array<{ status: string; result: Record<string, unknown> | null; scheduling: boolean }>>`
      SELECT status, result,
             (result->'scheduling' IS NOT NULL AND (result->'scheduling'->>'at')::timestamptz >= NOW() - ${SCHEDULE_CLAIM_TTL}::interval) AS scheduling
      FROM wl_content_batches WHERE id = ${id} FOR UPDATE`;
    if (!batch) throw new NotFoundError('Batch not found');
    if (batch.scheduling) throw new ConflictError('This batch is being put into next weekend right now — undo it in a moment');
    if (batch.status === 'processing') throw new ConflictError('Batch is still being processed');
    if (batch.status === 'undoing') throw new ConflictError('Undo already in progress for this batch');
    if (batch.status === 'undone') {
      const undo = (batch.result?.['undo'] as { staging_pending_ids?: string[]; photos_pending?: boolean } | undefined) ?? {};
      const pending = undo.staging_pending_ids ?? [];
      if (!pending.length && !undo.photos_pending) throw new ConflictError('Batch is already undone');
      return { mode: 'retry' as const, claimToken: '', pending, deletable: [] as Array<{ row_index: number; question_id: string }>, kept: [] as string[] };
    }
    const rows = await x<Array<{ row_index: number; question_id: string; referenced: boolean }>>`
      SELECT r.row_index, r.question_id,
             EXISTS (SELECT 1 FROM wl_questions w WHERE w.source_question_id = r.question_id)
             OR EXISTS (
               SELECT 1 FROM wl_content_reseeds rs, jsonb_array_elements(rs.previous_rows) prev
               WHERE prev->>'source_question_id' = r.question_id::text
             ) AS referenced
      FROM wl_content_batch_rows r WHERE r.batch_id = ${id} AND r.question_id IS NOT NULL AND r.state <> 'deleted'
    `;
    // The claim token ties phase 3 to THIS request: a stale request cannot finalize
    // a claim that reconciliation reset and another undo re-took.
    const claimToken = randomUUID();
    await x`UPDATE wl_content_batches SET status = 'undoing', updated_at = NOW(),
            result = coalesce(result, '{}'::jsonb) || ${sql.json({ undo_claim: claimToken } as never)} WHERE id = ${id}`;
    return {
      mode: 'undo' as const,
      claimToken,
      pending: [] as string[],
      deletable: rows.filter((r) => !r.referenced).map((r) => ({ row_index: r.row_index, question_id: r.question_id })),
      kept: rows.filter((r) => r.referenced).map((r) => r.question_id),
    };
  });

  if (claim.mode === 'retry') {
    let n: number | null = null;
    if (claim.pending.length) {
      n = await stagingDelete(claim.pending);
      await sql`UPDATE wl_content_batches SET updated_at = NOW(),
                result = jsonb_set(coalesce(result, '{}'::jsonb), '{undo,staging_pending_ids}', ${sql.json((n >= 0 ? [] : claim.pending) as never)})
                || ${sql.json({ undo_retry: { by: actor, at: new Date().toISOString(), staging_deleted: n } } as never)} WHERE id = ${id}`;
    }
    // Staging rows go first: their payloads are what keeps a photo "in use" there.
    return { deleted: 0, kept: 0, kept_ids: [], staging_deleted: n, photos: await awaitPhotoCleanup(id) };
  }

  // Phase 2 — staging, outside any transaction (it can be slow or fail; failure is recorded, never fatal).
  const ids = claim.deletable.map((r) => r.question_id);
  const stagingDeleted: number | null = ids.length && (config.STAGING_DATABASE_URL || config.NODE_ENV === 'prod') ? await stagingDelete(ids) : null;

  // Phase 3 — lock again, verify our claim, delete + bookkeeping together.
  // On ANY failure the claim is released right away (status back to 'failed'
  // with the reason) so the editor can retry now instead of after the
  // 10-minute stale window.
  const finalize = async () => sql.begin(async (tx) => {
    const x = tx as unknown as typeof sql;
    const [batch] = await x<Array<{ status: string; claim: string | null }>>`SELECT status, result->>'undo_claim' AS claim FROM wl_content_batches WHERE id = ${id} FOR UPDATE`;
    if (batch?.status !== 'undoing' || batch.claim !== claim.claimToken) throw new ConflictError(`Batch changed state during undo (${batch?.status ?? 'missing'})`);
    let gone: string[] = [];
    let dealtMeanwhile: string[] = [];
    if (ids.length) {
      // Lock the rows (a re-draw's FK check on them now waits for us), then re-check: a
      // question dealt or backed up since phase 1 is kept instead of failing the undo.
      await x`SELECT id FROM questions WHERE id = ANY(${sql.array(ids)}::uuid[]) FOR UPDATE`;
      const busy = await x<Array<{ id: string }>>`
        SELECT q.id FROM unnest(${sql.array(ids)}::uuid[]) AS q(id)
        WHERE EXISTS (SELECT 1 FROM wl_questions w WHERE w.source_question_id = q.id)
           OR EXISTS (SELECT 1 FROM wl_content_reseeds rs, jsonb_array_elements(rs.previous_rows) prev WHERE prev->>'source_question_id' = q.id::text)`;
      dealtMeanwhile = busy.map((r) => r.id);
      gone = ids.filter((q) => !dealtMeanwhile.includes(q));
      const goneRows = claim.deletable.filter((r) => gone.includes(r.question_id)).map((r) => r.row_index);
      // Rows keep their summary; the FK sets question_id NULL on delete.
      await x`UPDATE wl_content_batch_rows SET state = 'deleted', error = NULL WHERE batch_id = ${id} AND row_index = ANY(${sql.array(goneRows)}::int[])`;
      await x`DELETE FROM question_payloads WHERE question_id = ANY(${sql.array(gone)}::uuid[])`;
      await x`DELETE FROM questions WHERE id = ANY(${sql.array(gone)}::uuid[])`;
    }
    const kept = [...claim.kept, ...dealtMeanwhile];
    await x`UPDATE wl_content_batches SET status = 'undone', undone_at = NOW(), updated_at = NOW(), error = NULL,
            result = (coalesce(result, '{}'::jsonb) - 'undo_claim') || ${sql.json({ undo: { by: actor, deleted: gone.length, kept, staging_deleted: stagingDeleted, staging_pending_ids: stagingDeleted === -1 ? ids : [], photos_pending: true } } as never)} WHERE id = ${id}`;
    return { gone, kept };
  });
  let outcome: { gone: string[]; kept: string[] };
  try {
    outcome = await finalize();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sql`UPDATE wl_content_batches SET status = 'failed', error = ${`undo failed: ${message} — run undo again`}, updated_at = NOW(),
              result = coalesce(result, '{}'::jsonb) - 'undo_claim'
              WHERE id = ${id} AND status = 'undoing' AND result->>'undo_claim' = ${claim.claimToken}`.catch(() => {});
    logger.error({ err, batchId: id }, 'WL content undo: finalize failed — claim released');
    throw err;
  }
  if (outcome.gone.length) { invalidateCategoryCache(); invalidateContentIndex(); }
  if (outcome.kept.length > claim.kept.length) logger.warn({ batchId: id, dealtMeanwhile: outcome.kept.length - claim.kept.length }, 'WL content undo: questions dealt during the undo were kept (their staging copies may already be gone)');
  return { deleted: outcome.gone.length, kept: outcome.kept.length, kept_ids: outcome.kept, staging_deleted: stagingDeleted, photos: await awaitPhotoCleanup(id) };
}

// ─── runway ───────────────────────────────────────────────────────────────────

const RUNWAY_KINDS: WlRoundKind[] = [...WL_ROUND_ORDER];

export async function wlContentRunway(): Promise<{
  need_per_event: Record<string, number>;
  inventory: Array<{ type: string; difficulty: string; photo: boolean; fresh: number }>;
  drawable: Array<{ kind: string; drawable: number; need: number; events_left: number }>;
  fresh_events_left: Record<string, number>;
}> {
  const need: Record<string, number> = {};
  for (const k of RUNWAY_KINDS) need[k] = wlSourceNeedPerKind(k);

  // Fresh editor inventory: published, protected, editor-authored, never dealt in a real event.
  const inventory = await sql<Array<{ type: string; difficulty: string; photo: boolean; fresh: number }>>`
    SELECT q.type, q.difficulty,
           (q.type = 'mcq_single' AND qp.payload->'image'->>'url' IS NOT NULL) AS photo,
           count(*)::int AS fresh
    FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
    WHERE q.visibility = 'wl_private' AND q.status = 'published'
      AND q.type = ANY(${sql.array([...WL_CONTENT_KINDS])})
      AND (q.created_by IS NULL OR EXISTS (SELECT 1 FROM wl_content_batch_rows b WHERE b.question_id = q.id))
      AND NOT EXISTS (
        SELECT 1 FROM wl_questions w JOIN wl_tournaments t ON t.id = w.tournament_id
        WHERE w.source_question_id = q.id AND t.is_test = false
      )
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
  `;

  // Drawable now: the seeder's eligibility (protected, published, bilingual,
  // not dealt by a real event in the last WL_REPEAT_AVOID_DAYS). The bilingual
  // rule is the seeder's payloadFullyBilingual walk expressed as a jsonpath
  // (any object carrying en or ka must carry both, non-empty) so no payloads
  // cross the wire; verified identical to the JS walk on staging.
  const drawableRows = await sql<Array<{ type: string; n: number }>>`
    SELECT q.type, count(*)::int AS n
    FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
    WHERE q.visibility = 'wl_private' AND q.status = 'published'
      AND q.type = ANY(${sql.array([...WL_CONTENT_KINDS])})
      AND coalesce(q.prompt->>'ka', '') <> '' AND coalesce(q.prompt->>'en', '') <> ''
      AND NOT jsonb_path_exists(qp.payload, 'strict $.** ? ((exists(@.en) || exists(@.ka)) && (!exists(@.ka) || @.ka == "" || !exists(@.en) || @.en == ""))', '{}', true)
      AND NOT EXISTS (
        SELECT 1 FROM wl_questions w JOIN wl_tournaments t ON t.id = w.tournament_id
        WHERE w.source_question_id = q.id AND t.is_test = false
          AND t.created_at > NOW() - make_interval(days => ${WL_REPEAT_AVOID_DAYS})
      )
    GROUP BY 1
  `;
  const drawableByType: Record<string, number> = Object.fromEntries(drawableRows.map((r) => [r.type, r.n]));
  const drawable = RUNWAY_KINDS.map((kind) => {
    const type = WL_KIND_TO_TYPE[kind]!;
    const n = drawableByType[type] ?? 0;
    return { kind, drawable: n, need: need[kind]!, events_left: Math.floor(n / need[kind]!) };
  });
  const freshByType: Record<string, number> = {};
  for (const row of inventory) freshByType[row.type] = (freshByType[row.type] ?? 0) + row.fresh;
  const fresh_events_left: Record<string, number> = {};
  for (const kind of RUNWAY_KINDS) fresh_events_left[kind] = Math.floor((freshByType[WL_KIND_TO_TYPE[kind]!] ?? 0) / need[kind]!);
  return { need_per_event: need, inventory, drawable, fresh_events_left };
}

// ─── next event ───────────────────────────────────────────────────────────────

/**
 * Reseed is allowed only after the orchestrator has finished its own seeding
 * (ready or later) and before play — during scheduled/content_pending the
 * orchestrator may be seeding concurrently.
 */
export const RESEEDABLE_STATUSES = ['ready', 'entry_open', 'entry_closed'];

export interface WlNextEventQuestion {
  kind: string;
  reserve_ordinal: number;
  question_index: number | null;
  prompt: I18nField | null;
  options: Array<{ id: string; text: I18nField; correct: boolean }> | null;
  image_url: string | null;
  clubs: Array<{ name: I18nField; logo_url: string | null }> | null;
  clues: I18nField[] | null;
  answer: I18nField | null;
  accepted_answers: string[] | null;
  difficulty: string | null;
  source_question_id: string | null;
  editor: boolean;
  /** The upload batch that created the source question (null for older/agent content). */
  batch?: { id: string; kind: string; created_at: string; note: string | null } | null;
}

/**
 * Legacy safety net for a reseed record left without a result (the current
 * reseed replaces content in one transaction, so this only fires for a crash
 * mid-transaction — which rolls back — or for rows written by an older build).
 * Runs under the tournament row lock so it cannot cross a live reseed.
 */
export async function restoreInterruptedReseeds(tournamentId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const x = tx as unknown as typeof sql;
    await x`SELECT id FROM wl_tournaments WHERE id = ${tournamentId} FOR UPDATE`;
    const [r] = await x<Array<{ id: string; previous_rows: unknown[] }>>`
      SELECT id, previous_rows FROM wl_content_reseeds
      WHERE tournament_id = ${tournamentId} AND result IS NULL AND created_at < NOW() - interval '2 minutes'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!r) return;
    const [{ n }] = await x<Array<{ n: number }>>`SELECT count(*)::int AS n FROM wl_questions WHERE tournament_id = ${tournamentId}`;
    let restored = 0;
    if (n === 0 && r.previous_rows.length) {
      await x`INSERT INTO wl_questions SELECT * FROM jsonb_populate_recordset(NULL::wl_questions, ${sql.json(r.previous_rows as never)})`;
      restored = r.previous_rows.length;
      logger.warn({ tournamentId, reseedId: r.id, restored }, 'WL content: restored rows of an interrupted reseed');
    }
    await x`UPDATE wl_content_reseeds SET result = ${sql.json({ ok: false, interrupted: true, restored } as never)} WHERE id = ${r.id}`;
  });
}

/** How the CMS shows one dealt (or about-to-be-dealt) question: prompt, options with the key, photo, crests, clues, answer. */
export function wlQuestionView(r: { kind: string; reserve_ordinal: number; question_index: number | null; payload: Record<string, unknown>; evaluation: Record<string, unknown>; source_question_id: string | null; difficulty: string | null; editor: boolean }): WlNextEventQuestion {
  const p = r.payload; const e = r.evaluation;
  const clubs = Array.isArray(p['clubs'])
    ? (p['clubs'] as I18nField[]).map((c) => { const hit = findCrestClub(en(c)); return { name: c, logo_url: hit ? crestUrl(hit) : null }; })
    : null;
  const options = Array.isArray(p['options'])
    ? (p['options'] as Array<{ id: string; text: I18nField }>).map((o) => ({ id: o.id, text: o.text, correct: o.id === e['correct_id'] }))
    : null;
  const items = Array.isArray(p['items']) ? (p['items'] as Array<{ id: string; label: I18nField }>) : null;
  const orderedItems = items && Array.isArray(e['order'])
    ? (e['order'] as string[]).map((id) => items.find((i) => i.id === id)).filter((i): i is { id: string; label: I18nField } => Boolean(i)).map((i) => ({ id: i.id, text: i.label, correct: true }))
    : null;
  const clues = Array.isArray(p['clues']) ? (p['clues'] as Array<{ content?: I18nField } | I18nField>).map((c) => ('content' in c && c.content ? c.content : c) as I18nField) : null;
  return {
    kind: r.kind, reserve_ordinal: r.reserve_ordinal, question_index: r.question_index,
    prompt: (p['prompt'] as I18nField | undefined) ?? null,
    options: options ?? orderedItems,
    image_url: ((p['image'] as { url?: string } | null | undefined)?.url) ?? null,
    clubs, clues,
    answer: (e['display_answer'] as I18nField | undefined) ?? (r.kind === 'true_false' ? { en: e['correct_id'] === 'true' ? 'True' : 'False', ka: e['correct_id'] === 'true' ? 'მართალია' : 'მცდარია' } : null),
    accepted_answers: (e['accepted_answers'] as string[] | undefined) ?? null,
    difficulty: r.difficulty, source_question_id: r.source_question_id, editor: r.editor,
  };
};

export async function wlContentNextEvent(tournamentId?: string): Promise<{
  tournament: { id: string; week_key: string; status: string; is_test: boolean; qualifier_starts_at: string | null; final_starts_at: string | null; answers: number; can_reseed: boolean } | null;
  seeded: boolean;
  games: Array<{ game_index: number; rounds: Array<{ kind: string; played: WlNextEventQuestion[]; reserves: WlNextEventQuestion[] }> }>;
}> {
  const [t] = await sql<Array<{ id: string; week_key: string; status: string; is_test: boolean; qualifier_starts_at: string | null; final_starts_at: string | null; answers: number }>>`
    SELECT t.id, t.week_key::text AS week_key, t.status, t.is_test, t.qualifier_starts_at, t.final_starts_at,
           (SELECT count(*)::int FROM wl_answers a WHERE a.tournament_id = t.id) AS answers
    FROM wl_tournaments t
    WHERE t.is_test = false AND (${tournamentId ?? null}::uuid IS NULL AND t.status NOT IN ('completed', 'cancelled') OR t.id = ${tournamentId ?? null}::uuid)
    ORDER BY t.week_key ASC LIMIT 1
  `;
  if (!t) return { tournament: null, seeded: false, games: [] };
  await restoreInterruptedReseeds(t.id);
  const rows = await sql<Array<{ game_index: number; round_index: number | null; question_index: number | null; reserve_ordinal: number; kind: string; payload: Record<string, unknown>; evaluation: Record<string, unknown>; source_question_id: string | null; difficulty: string | null; editor: boolean; batch: WlNextEventQuestion['batch'] }>>`
    SELECT w.game_index, w.round_index, w.question_index, w.reserve_ordinal, w.kind, w.payload, w.evaluation, w.source_question_id,
           q.difficulty,
           (q.created_by IS NULL OR EXISTS (SELECT 1 FROM wl_content_batch_rows b WHERE b.question_id = q.id)) AS editor,
           (SELECT json_build_object('id', b.id, 'kind', b.kind, 'created_at', b.created_at, 'note', b.note)
            FROM wl_content_batch_rows br JOIN wl_content_batches b ON b.id = br.batch_id
            WHERE br.question_id = w.source_question_id LIMIT 1) AS batch
    FROM wl_questions w LEFT JOIN questions q ON q.id = w.source_question_id
    WHERE w.tournament_id = ${t.id}
    ORDER BY w.game_index, w.reserve_ordinal, w.round_index, w.question_index
  `;
  const view = (r: typeof rows[number]): WlNextEventQuestion => ({ ...wlQuestionView(r), batch: r.batch });
  const games = Array.from({ length: WL_GAME_COUNT }, (_, g) => ({
    game_index: g,
    rounds: WL_ROUND_ORDER.map((kind) => ({
      kind,
      played: rows.filter((r) => r.game_index === g && r.kind === kind && r.reserve_ordinal === 0).map(view),
      reserves: rows.filter((r) => r.game_index === g && r.kind === kind && r.reserve_ordinal > 0).map(view),
    })),
  }));
  return {
    tournament: { ...t, can_reseed: t.answers === 0 && RESEEDABLE_STATUSES.includes(t.status) },
    seeded: rows.length > 0,
    games,
  };
}

let reseedInFlight: Promise<unknown> = Promise.resolve();

/**
 * Replace the frozen content of a not-yet-played tournament with a fresh draw
 * from the current pool (editor content first). The draw is planned FIRST;
 * then, in one transaction holding the tournament row lock, eligibility is
 * re-checked, the previous rows are snapshotted, deleted and the new ones
 * inserted — the event is never observable empty and a failure rolls back.
 * A short draw creates no reseed record beyond an audit line.
 */
const SCHEDULE_CLAIM_TTL = '10 minutes';

type ReseedOutcome = { ok: boolean; inserted: number; previous_rows: number; shortages?: Record<string, { need: number; have: number }>; reseed_id: string | null };

interface ScheduleClaim { batchId: string; token: string }

export async function wlContentReseed(tournamentId: string, actor: string, priorityIds: readonly string[] = [], claim?: ScheduleClaim): Promise<ReseedOutcome> {
  const run = reseedInFlight.then(() => reseedNow(tournamentId, actor, priorityIds, claim));
  reseedInFlight = run.catch(() => {});
  return run;
}

async function reseedNow(tournamentId: string, actor: string, priorityIds: readonly string[], claim?: ScheduleClaim): Promise<ReseedOutcome> {
  await restoreInterruptedReseeds(tournamentId);
  const [pre] = await sql<Array<{ status: string; answers: number; rows: number }>>`
    SELECT t.status,
           (SELECT count(*)::int FROM wl_answers a WHERE a.tournament_id = t.id) AS answers,
           (SELECT count(*)::int FROM wl_questions w WHERE w.tournament_id = t.id) AS rows
    FROM wl_tournaments t WHERE t.id = ${tournamentId}
  `;
  if (!pre) throw new NotFoundError('Tournament not found');
  if (!RESEEDABLE_STATUSES.includes(pre.status)) throw new ConflictError(`Cannot reseed a tournament in status '${pre.status}'`);
  if (pre.answers > 0) throw new ConflictError('Play has started — content is locked');

  // 1. Plan the draw with the current rows still in place (they stay eligible via reseedOf).
  const plan = await wlPlanTournamentContent({ tournamentId, allowPublicBank: false, deterministic: false, reseedOf: tournamentId, priorityIds });
  if (!plan.ok) {
    const [audit] = await sql<Array<{ id: string }>>`
      INSERT INTO wl_content_reseeds (tournament_id, actor, previous_rows, result)
      VALUES (${tournamentId}, ${actor}, '[]'::jsonb, ${sql.json({ ok: false, shortages: plan.shortages ?? {}, kept: pre.rows } as never)}) RETURNING id
    `;
    logger.warn({ tournamentId, actor, shortages: plan.shortages }, 'WL content reseed short on stock — content untouched');
    return { ok: false, inserted: 0, previous_rows: pre.rows, shortages: plan.shortages, reseed_id: audit!.id };
  }

  // 2. Swap atomically under the tournament lock, re-checking eligibility inside.
  return sql.begin(async (tx) => {
    const x = tx as unknown as typeof sql;
    const [t] = await x<Array<{ status: string; answers: number }>>`
      SELECT t.status, (SELECT count(*)::int FROM wl_answers a WHERE a.tournament_id = t.id) AS answers
      FROM wl_tournaments t WHERE t.id = ${tournamentId} FOR UPDATE
    `;
    if (!t) throw new NotFoundError('Tournament not found');
    if (!RESEEDABLE_STATUSES.includes(t.status)) throw new ConflictError(`Cannot reseed a tournament in status '${t.status}'`);
    if (t.answers > 0) throw new ConflictError('Play has started — content is locked');
    await wlLockContentAllocation(x);
    const taken = await wlSourcesTakenElsewhere(x, tournamentId, plan.slots.map((sl) => sl.sourceQuestionId));
    if (taken.length) throw new ConflictError('Another weekend just took some of these questions — re-draw again');
    if (claim) {
      // "Use in next weekend": commit only while this request still owns the batch claim and the
      // batch is still finished — an undo that ran after the claim expired rolls this back.
      const [b] = await x<Array<{ status: string; token: string | null }>>`
        SELECT status, result->'scheduling'->>'token' AS token FROM wl_content_batches WHERE id = ${claim.batchId} FOR SHARE`;
      if (!b || (b.status !== 'done' && b.status !== 'failed') || b.token !== claim.token) {
        throw new ConflictError('The batch changed while it was being scheduled (undone or re-claimed) — nothing was changed');
      }
    }
    const previous = await x<Array<Record<string, unknown>>>`SELECT * FROM wl_questions WHERE tournament_id = ${tournamentId}`;
    const [reseed] = await x<Array<{ id: string }>>`
      INSERT INTO wl_content_reseeds (tournament_id, actor, previous_rows, result)
      VALUES (${tournamentId}, ${actor}, ${sql.json(previous as never)}, ${sql.json({ ok: true, inserted: plan.slots.length, priority: priorityIds.length } as never)}) RETURNING id
    `;
    await x`DELETE FROM wl_questions WHERE tournament_id = ${tournamentId}`;
    await wlInsertTournamentSlots(x, tournamentId, plan.slots);
    logger.info({ tournamentId, actor, inserted: plan.slots.length, previous: previous.length }, 'WL content reseeded from CMS');
    return { ok: true, inserted: plan.slots.length, previous_rows: previous.length, reseed_id: reseed!.id };
  });
}

/**
 * "Use in next weekend": re-draw the coming event with this batch's published
 * questions drawn first. The draw still applies repeat-avoid and bilingual
 * checks and only runs while the event is re-drawable (no answers yet).
 */
export async function wlContentScheduleBatch(batchId: string, actor: string, tournamentId?: string): Promise<ReseedOutcome & { week_key: string; placed_main: number; placed_reserve: number; not_placed: number }> {
  // Claim the batch on its row (works through the transaction pooler, unlike a session lock):
  // undo refuses while the claim is fresh, so the batch cannot vanish between reading its
  // questions and dealing them. A crashed claim expires after SCHEDULE_CLAIM_TTL.
  const token = randomUUID();
  const [claimed] = await sql<Array<{ id: string }>>`
    UPDATE wl_content_batches
    SET result = coalesce(result, '{}'::jsonb) || ${sql.json({ scheduling: { token, at: new Date().toISOString() } } as never)}
    WHERE id = ${batchId} AND status IN ('done', 'failed')
      AND (result->'scheduling' IS NULL OR (result->'scheduling'->>'at')::timestamptz < NOW() - ${SCHEDULE_CLAIM_TTL}::interval)
    RETURNING id`;
  if (!claimed) {
    const [b] = await sql<Array<{ status: string }>>`SELECT status FROM wl_content_batches WHERE id = ${batchId}`;
    if (!b) throw new NotFoundError('Batch not found');
    if (b.status !== 'done' && b.status !== 'failed') throw new ConflictError(`Batch is ${b.status}; only a finished batch can be scheduled`);
    throw new ConflictError('This batch is already being scheduled — try again in a moment');
  }
  try {
    return await scheduleLocked(batchId, actor, { batchId, token }, tournamentId);
  } finally {
    await sql`UPDATE wl_content_batches SET result = result - 'scheduling' WHERE id = ${batchId} AND result->'scheduling'->>'token' = ${token}`
      .catch((err) => logger.warn({ err, batchId }, 'WL content: could not release the schedule claim (expires by itself)'));
  }
}

async function scheduleLocked(batchId: string, actor: string, claim: ScheduleClaim, tournamentId?: string): Promise<ReseedOutcome & { week_key: string; placed_main: number; placed_reserve: number; not_placed: number }> {
  const [batch] = await sql<Array<{ status: string; kind: string }>>`SELECT status, kind FROM wl_content_batches WHERE id = ${batchId}`;
  if (!batch) throw new NotFoundError('Batch not found');
  if (batch.kind === 'lineup') throw new ConflictError('A lineup upload already has its exact places — upload a new lineup to change them');
  if (batch.status !== 'done' && batch.status !== 'failed') throw new ConflictError(`Batch is ${batch.status}; only a finished batch can be scheduled`);
  const ids = (await sql<Array<{ id: string }>>`
    SELECT q.id FROM wl_content_batch_rows r JOIN questions q ON q.id = r.question_id
    WHERE r.batch_id = ${batchId} AND q.status = 'published'`).map((r) => r.id);
  if (!ids.length) throw new ConflictError('This batch has no published questions');
  // The event the CMS shows on "Next weekend" (passed explicitly), else the same lookup it uses.
  const [t] = tournamentId
    ? await sql<Array<{ id: string; week_key: string }>>`SELECT id, coalesce(week_key::text, '') AS week_key FROM wl_tournaments WHERE id = ${tournamentId} AND is_test = false`
    : await sql<Array<{ id: string; week_key: string }>>`
      SELECT id, week_key::text AS week_key FROM wl_tournaments
      WHERE is_test = false AND status NOT IN ('completed', 'cancelled') ORDER BY week_key ASC LIMIT 1`;
  if (!t) throw new ConflictError('There is no coming weekend to schedule into');
  const outcome = await wlContentReseed(t.id, actor, ids, claim);
  const placed = await sql<Array<{ main: number; reserve: number }>>`
    SELECT count(DISTINCT source_question_id) FILTER (WHERE reserve_ordinal = 0)::int AS main,
           count(DISTINCT source_question_id) FILTER (WHERE reserve_ordinal > 0)::int AS reserve
    FROM wl_questions WHERE tournament_id = ${t.id} AND source_question_id = ANY(${sql.array(ids)}::uuid[])`;
  const main = placed[0]?.main ?? 0; const reserve = placed[0]?.reserve ?? 0;
  logger.info({ batchId, tournamentId: t.id, actor, main, reserve, of: ids.length }, 'WL content batch scheduled into the coming event');
  return { ...outcome, week_key: t.week_key, placed_main: main, placed_reserve: reserve, not_placed: ids.length - main - reserve };
}
