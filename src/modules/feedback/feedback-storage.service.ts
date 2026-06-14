import { createHash, randomUUID } from 'node:crypto';
import { config } from '../../core/config.js';
import { BadRequestError, ExternalServiceError, InternalError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

// Feedback attachments go to the existing public `imgs` bucket under a feedback/
// prefix, uploaded via the Supabase Storage REST API with the service-role key
// (mirrors question-image-storage.service — no SDK, no multipart).
const BUCKET = 'imgs';
const PREFIX = 'feedback';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const MAX_BYTES = 50 * 1024 * 1024; // 50MB per file (post-decode)
const UPLOAD_TIMEOUT_MS = 60_000; // generous — large video uploads take time

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

function normalizeSupabaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new BadRequestError('Invalid attachment data URL');
  const mime = match[1].toLowerCase();
  if (!EXT_BY_MIME[mime]) throw new BadRequestError(`Unsupported attachment type: ${mime}`);
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) throw new BadRequestError('Empty attachment');
  if (buffer.length > MAX_BYTES) throw new BadRequestError('Attachment exceeds 50MB');
  return { mime, buffer };
}

/**
 * Upload one base64 data-URL attachment to storage and return its public URL.
 */
async function uploadOne(dataUrl: string): Promise<string> {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new InternalError('Attachment storage is not configured');
  }
  const { mime, buffer } = parseDataUrl(dataUrl);
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const objectPath = `${PREFIX}/${randomUUID()}-${hash}.${EXT_BY_MIME[mime]}`;
  const base = normalizeSupabaseUrl(config.SUPABASE_URL);
  const uploadUrl = `${base}/storage/v1/object/${BUCKET}/${objectPath}`;

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': mime,
      'cache-control': CACHE_CONTROL,
      'x-upsert': 'true',
    },
    body: new Uint8Array(buffer),
    // Bound the upload so a hung storage backend doesn't tie up the handler.
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  }).catch((err) => {
    logger.error({ err }, 'Feedback attachment upload failed (network/timeout)');
    throw new ExternalServiceError('Failed to upload attachment');
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.error({ status: response.status, detail }, 'Storage rejected feedback attachment');
    throw new ExternalServiceError('Storage rejected the attachment');
  }

  return `${base}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

export const feedbackStorageService = {
  /** Upload all attachments (data URLs) and return their public URLs, in order. */
  async uploadAttachments(dataUrls: string[]): Promise<string[]> {
    const urls: string[] = [];
    for (const dataUrl of dataUrls) {
      urls.push(await uploadOne(dataUrl));
    }
    return urls;
  },
};
