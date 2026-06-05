import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { config } from '../../core/config.js';
import { BadRequestError, ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { Json } from '../../db/types.js';
import type { McqImage } from './questions.schemas.js';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const BUCKET = 'imgs';
const IMAGE_PREFIX = 'question-images';
const USER_AGENT = 'QuizballQuestionImageIngest/1.0';

export const DEFAULT_QUESTION_IMAGE_WIDTH = 1440;
export const DEFAULT_QUESTION_IMAGE_HEIGHT = 1080;

export interface QuestionImageStorageTarget {
  supabaseUrl: string;
  serviceRoleKey: string;
  label: string;
}

export type QuestionImageIngestCache = Map<string, McqImage>;

function aspectRatio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'image';
}

function normalizeSupabaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

function publicObjectBaseUrl(target: QuestionImageStorageTarget): string {
  return `${normalizeSupabaseUrl(target.supabaseUrl)}/storage/v1/object/public/${BUCKET}/${IMAGE_PREFIX}/`;
}

function isStoredInTarget(url: string, target: QuestionImageStorageTarget): boolean {
  return url.startsWith(publicObjectBaseUrl(target));
}

function validateHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestError('Question image URL is invalid');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestError('Question image URL must use http or https');
  }
}

function getPrimaryStorageTarget(): QuestionImageStorageTarget {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ExternalServiceError('Supabase storage is not configured');
  }

  return {
    supabaseUrl: config.SUPABASE_URL,
    serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
    label: config.NODE_ENV,
  };
}

async function normalizeImageToTransparentPng(input: Buffer, width: number, height: number): Promise<Buffer> {
  try {
    const source = sharp(input, { failOn: 'none' }).rotate().ensureAlpha();
    const metadata = await source.metadata();
    const trimmed = metadata.hasAlpha
      ? await source
          .clone()
          .trim({
            background: { r: 0, g: 0, b: 0, alpha: 0 },
            threshold: 1,
          })
          .toBuffer()
      : await source.clone().toBuffer();

    return sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: await sharp(trimmed)
            .resize({
              width,
              height,
              fit: 'contain',
              withoutEnlargement: false,
            })
            .png()
            .toBuffer(),
          gravity: 'centre',
        },
      ])
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } catch (error) {
    throw new BadRequestError(`Image normalization failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function downloadImage(url: string): Promise<Buffer> {
  validateHttpUrl(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ExternalServiceError(`Image download failed: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new BadRequestError(`Question image URL must point directly to an image. Received content-type: ${contentType || 'unknown'}`);
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_IMAGE_BYTES) {
      throw new BadRequestError(`Question image is too large. Maximum size is ${MAX_IMAGE_BYTES} bytes.`);
    }

    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_IMAGE_BYTES) {
      throw new BadRequestError(`Question image is too large. Maximum size is ${MAX_IMAGE_BYTES} bytes.`);
    }

    return body;
  } catch (error) {
    if (error instanceof BadRequestError || error instanceof ExternalServiceError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ExternalServiceError('Question image download timed out');
    }
    throw new ExternalServiceError(`Question image download failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function uploadQuestionImageBuffer(
  png: Buffer,
  options: {
    categorySlug: string;
    width: number;
    height: number;
    target?: QuestionImageStorageTarget;
  }
): Promise<Pick<McqImage, 'url' | 'width' | 'height' | 'aspect_ratio'>> {
  const target = options.target ?? getPrimaryStorageTarget();
  const hash = createHash('sha256').update(png).digest('hex').slice(0, 24);
  const objectPath = `${IMAGE_PREFIX}/${slugify(options.categorySlug)}/${hash}.png`;
  const uploadUrl = `${normalizeSupabaseUrl(target.supabaseUrl)}/storage/v1/object/${BUCKET}/${objectPath}`;

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.serviceRoleKey}`,
      'Content-Type': 'image/png',
      'cache-control': CACHE_CONTROL,
      'x-upsert': 'true',
    },
    body: new Uint8Array(png),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.error(
      { status: response.status, target: target.label, detail: detail.slice(0, 200) },
      'Question image upload failed'
    );
    throw new ExternalServiceError(`Question image upload failed: ${response.status}`);
  }

  return {
    url: `${normalizeSupabaseUrl(target.supabaseUrl)}/storage/v1/object/public/${BUCKET}/${objectPath}`,
    width: options.width,
    height: options.height,
    aspect_ratio: aspectRatio(options.width, options.height),
  };
}

function imageCacheKey(image: McqImage, target: QuestionImageStorageTarget): string {
  return [
    target.supabaseUrl,
    image.source_url ?? image.url,
    image.width,
    image.height,
  ].join('|');
}

async function ingestImageUrl(
  image: McqImage,
  options: {
    categorySlug: string;
    target: QuestionImageStorageTarget;
  }
): Promise<McqImage> {
  const width = image.width || DEFAULT_QUESTION_IMAGE_WIDTH;
  const height = image.height || DEFAULT_QUESTION_IMAGE_HEIGHT;
  const sourceCandidates = [...new Set([image.source_url, image.url].filter((value): value is string => Boolean(value)))];
  let lastError: unknown = null;

  for (const sourceUrl of sourceCandidates) {
    try {
      const downloaded = await downloadImage(sourceUrl);
      const png = await normalizeImageToTransparentPng(downloaded, width, height);
      const stored = await uploadQuestionImageBuffer(png, {
        categorySlug: options.categorySlug,
        width,
        height,
        target: options.target,
      });

      return {
        ...image,
        ...stored,
        source_url: image.source_url ?? image.url,
        provider: image.provider ?? 'bulk_upload',
      };
    } catch (error) {
      lastError = error;
      logger.warn(
        {
          sourceUrl,
          categorySlug: options.categorySlug,
          target: options.target.label,
          error: error instanceof Error ? error.message : String(error),
        },
        'Question image ingest source failed'
      );
    }
  }

  if (lastError instanceof BadRequestError || lastError instanceof ExternalServiceError) throw lastError;
  throw new ExternalServiceError('Question image ingest failed');
}

export async function ensureQuestionImageStored(
  image: McqImage,
  options: {
    categorySlug: string;
    target?: QuestionImageStorageTarget;
    cache?: QuestionImageIngestCache;
  }
): Promise<McqImage> {
  const target = options.target ?? getPrimaryStorageTarget();
  if (isStoredInTarget(image.url, target)) {
    return image;
  }

  const cacheKey = imageCacheKey(image, target);
  const cached = options.cache?.get(cacheKey);
  if (cached) return cached;

  const stored = await ingestImageUrl(image, {
    categorySlug: options.categorySlug,
    target,
  });

  options.cache?.set(cacheKey, stored);
  return stored;
}

export async function storeQuestionPayloadImages(
  payload: Json | undefined,
  options: {
    categorySlug: string;
    target?: QuestionImageStorageTarget;
    cache?: QuestionImageIngestCache;
  }
): Promise<Json | undefined> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  const candidate = payload as { type?: unknown; image?: unknown };
  if (candidate.type !== 'mcq_single' || !candidate.image || typeof candidate.image !== 'object' || Array.isArray(candidate.image)) {
    return payload;
  }

  const image = candidate.image as McqImage;
  const storedImage = await ensureQuestionImageStored(image, options);
  return {
    ...payload,
    image: storedImage,
  } as Json;
}
