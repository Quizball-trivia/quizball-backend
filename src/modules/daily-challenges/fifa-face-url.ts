import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';

/**
 * Face photos are served by the web app's /api/fifa-face proxy. The backend
 * signs each (id, version) pair so the proxy can verify the request refers to a
 * card we actually serve, without shipping the card dataset to the proxy and
 * without letting the route be used to enumerate the upstream CDN. No expiry:
 * the signature only asserts "this is one of ours", and a static URL keeps the
 * proxy's long-lived CDN caching intact.
 */
let warnedMissingSecret = false;

export function fifaFaceSignature(photoId: number, photoVer: string, secret: string): string {
  return createHmac('sha256', secret).update(`${photoId}:${photoVer}`).digest('hex').slice(0, 32);
}

export function buildFifaFaceUrl(photoId: number | null, photoVer: string | null): string | null {
  if (!photoId || !photoVer) return null;
  const secret = config.FIFA_FACE_SIGNING_SECRET;
  if (!secret) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      logger.warn('FIFA_FACE_SIGNING_SECRET is not set; FIFA card sessions are served without face URLs');
    }
    return null;
  }
  const sig = fifaFaceSignature(photoId, photoVer, secret);
  return `/api/fifa-face?id=${photoId}&v=${encodeURIComponent(photoVer)}&sig=${sig}`;
}

/** Constant-time check used by tests and any server-side consumer of the signature. */
export function verifyFifaFaceSignature(photoId: number, photoVer: string, sig: string, secret: string): boolean {
  const expected = Buffer.from(fifaFaceSignature(photoId, photoVer, secret));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
