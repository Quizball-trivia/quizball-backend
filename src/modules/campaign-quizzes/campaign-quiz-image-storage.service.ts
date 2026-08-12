import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { config } from '../../core/config.js';
import { BadRequestError, ExternalServiceError, InternalError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

const BUCKET = 'imgs';
const PREFIX = 'campaign-quizzes';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const PUBLIC_OBJECT_PREFIX = `/storage/v1/object/public/${BUCKET}/`;

const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

function normalizeSupabaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function configuredPublicBaseUrl(objectPath: string): string | null {
  const usesLocalLegacyFallback = config.NODE_ENV === 'local'
    && !objectPath.startsWith(`${PREFIX}/`);
  const value = usesLocalLegacyFallback
    ? config.CAMPAIGN_QUIZ_ASSET_BASE_URL ?? config.SUPABASE_URL
    : config.SUPABASE_URL;
  return value ? normalizeSupabaseUrl(value) : null;
}

function objectPathFromPublicUrl(value: URL): string | null {
  const markerIndex = value.pathname.indexOf(PUBLIC_OBJECT_PREFIX);
  if (markerIndex < 0) return null;
  return value.pathname.slice(markerIndex + PUBLIC_OBJECT_PREFIX.length);
}

function validateObjectPath(value: string): string {
  const objectPath = value.replace(/^\/+/, '');
  if (
    objectPath.length === 0
    || objectPath.length > 1_000
    || objectPath.includes('..')
    || /[?#\\]/.test(objectPath)
  ) {
    throw new BadRequestError('Campaign artwork path is invalid');
  }
  return objectPath;
}

/**
 * Persist only an object path. A staging database must never retain a
 * production Storage origin (or vice versa) merely because the editor sent
 * back the preview URL it received from the API.
 */
export function normalizeCampaignQuizImageReference(value: string | null): string | null {
  if (!value) return null;

  if (!/^https?:\/\//i.test(value)) {
    return validateObjectPath(value);
  }

  const parsed = new URL(value);
  const objectPath = objectPathFromPublicUrl(parsed);
  if (!objectPath) {
    throw new BadRequestError('Campaign artwork must be uploaded through this CMS');
  }

  const allowedOrigins = [config.SUPABASE_URL]
    .concat(config.NODE_ENV === 'local' ? [config.CAMPAIGN_QUIZ_ASSET_BASE_URL] : [])
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => new URL(candidate).origin);
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new BadRequestError(
      `Campaign artwork belongs to a different environment; upload it again in ${config.NODE_ENV}`,
    );
  }

  return validateObjectPath(objectPath);
}

/**
 * Resolve stored paths against the active deployment. Legacy absolute
 * Supabase public URLs are deliberately rebased so copied rows cannot make a
 * staging page serve production media.
 */
export function publicCampaignQuizImageUrl(value: string | null): string | null {
  if (!value) return null;

  let objectPath: string;
  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    const parsedObjectPath = objectPathFromPublicUrl(parsed);
    if (!parsedObjectPath) return value;
    objectPath = validateObjectPath(parsedObjectPath);
  } else {
    if (value.startsWith('//')) {
      throw new BadRequestError('Campaign artwork path is invalid');
    }
    if (value.startsWith('/')) return value;
    objectPath = validateObjectPath(value);
  }

  const base = configuredPublicBaseUrl(objectPath);
  if (!base) return value;
  return `${base}${PUBLIC_OBJECT_PREFIX}${objectPath}`;
}

function parseDataUrl(dataUrl: string): Buffer {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new BadRequestError('Artwork must be an image upload');
  if (!SUPPORTED_MIME_TYPES.has(match[1].toLowerCase())) {
    throw new BadRequestError('Artwork must be PNG, JPEG, or WebP');
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) throw new BadRequestError('Artwork file is empty');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new BadRequestError('Artwork must be smaller than 10 MB');
  }
  return buffer;
}

function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function normalizeArtwork(input: Buffer): Promise<Buffer> {
  try {
    return await sharp(input, { failOn: 'error' })
      .rotate()
      .resize(1200, 1200, { fit: 'cover', position: 'centre' })
      .webp({ quality: 84, effort: 5 })
      .toBuffer();
  } catch (error) {
    throw new BadRequestError(
      `Artwork could not be processed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const campaignQuizImageStorageService = {
  async upload(input: {
    dataUrl: string;
    slug: string;
    kind: 'hero' | 'og';
  }): Promise<{ url: string; width: number; height: number; environment: 'local' | 'staging' | 'prod' }> {
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
      throw new InternalError('Campaign artwork storage is not configured');
    }

    const webp = await normalizeArtwork(parseDataUrl(input.dataUrl));
    const hash = createHash('sha256').update(webp).digest('hex').slice(0, 20);
    const objectPath = `${PREFIX}/${safeSlug(input.slug)}-cms-${input.kind}-${hash}.webp`;
    const base = normalizeSupabaseUrl(config.SUPABASE_URL);
    const response = await fetch(`${base}/storage/v1/object/${BUCKET}/${objectPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: config.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'image/webp',
        'cache-control': CACHE_CONTROL,
        'x-upsert': 'false',
      },
      body: new Uint8Array(webp),
      signal: AbortSignal.timeout(30_000),
    }).catch((error) => {
      logger.error({ error, objectPath }, 'Campaign artwork upload failed');
      throw new ExternalServiceError('Campaign artwork upload failed');
    });

    if (!response.ok && response.status !== 409) {
      const detail = await response.text().catch(() => '');
      logger.error(
        { status: response.status, detail: detail.slice(0, 300), objectPath },
        'Campaign artwork storage rejected upload',
      );
      throw new ExternalServiceError('Campaign artwork storage rejected the upload');
    }

    return {
      url: `${base}/storage/v1/object/public/${BUCKET}/${objectPath}`,
      width: 1200,
      height: 1200,
      environment: config.NODE_ENV,
    };
  },
};
