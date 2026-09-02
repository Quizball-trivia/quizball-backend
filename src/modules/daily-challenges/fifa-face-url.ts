import { config } from '../../core/config.js';

/**
 * Card faces are mirrored into our own Supabase storage bucket
 * (imgs/fifa-faces/<photoId>_<photoVer>.webp, see
 * frontend-web-next/scripts/fifa/mirror-faces.py and the agents' discover job),
 * so the game never depends on SoFIFA at runtime. The URL is derived by
 * convention; the web card falls back to its silhouette if an object is missing.
 */
export const FIFA_FACES_BUCKET_PATH = 'imgs/fifa-faces';

export function buildFifaFaceUrl(photoId: number | null, photoVer: string | null): string | null {
  if (!photoId || !photoVer) return null;
  const base = (config.SUPABASE_URL ?? '').replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/storage/v1/object/public/${FIFA_FACES_BUCKET_PATH}/${photoId}_${encodeURIComponent(photoVer)}.webp`;
}
