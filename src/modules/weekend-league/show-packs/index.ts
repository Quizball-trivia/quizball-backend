/**
 * Show packs are stored in wl_show_packs (one per slug + Monday), never in
 * code: the repo is public and a pack carries its answer keys. Load one with
 * scripts/wl-show-pack-load.ts --file <path in the private store>.
 */

import { sql } from '../../../db/index.js';
import { logger } from '../../../core/logger.js';
import { redactedIssues, showPackHash, showPackSchema, type ShowPack } from './show-pack.js';

type Db = typeof sql;

type StoredPack = { kind: 'none' } | { kind: 'invalid' } | { kind: 'ok'; pack: ShowPack };

async function readStoredPack(db: Db, slug: string, eventDate: string): Promise<StoredPack> {
  const [row] = await db<{ pack: unknown }[]>`
    SELECT pack FROM wl_show_packs WHERE slug = ${slug} AND event_date = ${eventDate}::date
    FOR SHARE
  `;
  if (!row) return { kind: 'none' };
  const parsed = showPackSchema.safeParse(row.pack);
  if (!parsed.success || parsed.data.slug !== slug || parsed.data.eventDate !== eventDate) {
    logger.error(
      { slug, eventDate, issues: parsed.success ? ['slug/eventDate mismatch'] : redactedIssues(parsed.error.issues) },
      'WL show pack in DB is invalid; the host cannot start until it is fixed'
    );
    return { kind: 'invalid' };
  }
  return { kind: 'ok', pack: parsed.data };
}

export async function findShowPack(slug: string, eventDate: string): Promise<ShowPack | null> {
  const stored = await readStoredPack(sql, slug, eventDate);
  return stored.kind === 'ok' ? stored.pack : null;
}

/**
 * Whether an event's questions match its stored pack, read inside the caller's
 * transaction (which holds the tournament row lock, as the loader does):
 *  - ok: no pack and none was ever loaded (bank questions), or the loaded pack is the stored one;
 *  - updating: the stored pack changed and the orchestrator has not swapped it in yet;
 *  - invalid: the stored pack is broken, or it was deleted after being loaded.
 */
export async function showPackReadiness(
  db: Db, slug: string, eventDate: string, appliedHash: string | null
): Promise<'ok' | 'updating' | 'invalid'> {
  const stored = await readStoredPack(db, slug, eventDate);
  if (stored.kind === 'invalid') return 'invalid';
  if (stored.kind === 'none') return appliedHash == null ? 'ok' : 'invalid';
  return showPackHash(stored.pack) === appliedHash ? 'ok' : 'updating';
}

/**
 * One lock per show night, taken first by the pack loader and by the host's Start (before any row lock, in the same
 * order), so a load and a Start never interleave — including before the event row exists — and can't deadlock.
 */
export async function lockShowNight(db: Db, slug: string, eventDate: string): Promise<void> {
  await db`SELECT pg_advisory_xact_lock(hashtext('wl_show_pack'), hashtext(${`${slug}:${eventDate}`}))`;
}
