import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { ttlCache } from './hq.cache.js';

/**
 * Play-test screenshots of builds, in the private `hq-builds` bucket. The Builder uploads them with the service role
 * and records their paths in the job's checkpoint (`shots`); the CMS gets short-lived signed links from here.
 */
export const HQ_BUILDS_BUCKET = 'hq-builds';
const SIGN_SECONDS = 60 * 60;
// Links are reused for 40 minutes, so a link handed out is always valid for at least 20 more.
const signed = ttlCache<string, string>(40 * 60_000);

/** builds/<job number>/<before|after>-<phone|desktop>-<hash prefix>.png — the only shape the Builder writes. */
const SHOT_PATH = /^builds\/\d{1,9}\/(before|after)-(phone|desktop)-[a-f0-9]{8,64}\.png$/;

export type ShotSize = 'phone' | 'desktop';
export interface BuildShot { size: ShotSize; url: string }
export interface BuildShots { at: string | null; before: BuildShot[]; after: BuildShot[] }

/** A signed link, or null. Failures are not cached (ttlCache keeps only resolved values), so the next listing retries. */
async function signOne(path: string): Promise<string | null> {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) return null;
  const base = config.SUPABASE_URL.replace(/\/$/, '');
  try {
    return await signed.get(path, async () => {
      const res = await fetch(`${base}/storage/v1/object/sign/${HQ_BUILDS_BUCKET}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: SIGN_SECONDS }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`storage answered ${res.status}`);
      const body = (await res.json()) as { signedURL?: string };
      if (!body.signedURL) throw new Error('storage returned no signed link');
      return `${base}/storage/v1${body.signedURL}`;
    });
  } catch (err) {
    logger.warn({ err, path }, 'hq: could not sign a build screenshot');
    return null;
  }
}

/** The job's recorded screenshots as signed links; anything malformed or unsignable is left out. */
export async function buildShots(raw: unknown): Promise<BuildShots | null> {
  if (!raw || typeof raw !== 'object') return null;
  const shots = raw as { at?: unknown; before?: unknown; after?: unknown };
  const side = async (list: unknown): Promise<BuildShot[]> => {
    if (!Array.isArray(list)) return [];
    const out: BuildShot[] = [];
    for (const s of list.slice(0, 4)) {
      const path = (s as { path?: unknown })?.path;
      const size = (s as { size?: unknown })?.size;
      if (typeof path !== 'string' || !SHOT_PATH.test(path) || (size !== 'phone' && size !== 'desktop')) continue;
      const url = await signOne(path);
      if (url) out.push({ size, url });
    }
    return out;
  };
  const [before, after] = await Promise.all([side(shots.before), side(shots.after)]);
  if (!before.length && !after.length) return null;
  return { at: typeof shots.at === 'string' ? shots.at : null, before, after };
}
