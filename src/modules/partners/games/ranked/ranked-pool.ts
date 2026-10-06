/** Which ranked pool a player is matched in (plan v4 §11 A.2): resolved here only, from the user row. */

import { logger } from '../../../../core/logger.js';
import {
  PUBLIC_RANKED_POOL,
  RANKED_MM_USER_MAP_KEY,
  rankedPoolKeys,
  type RankedPool,
} from '../../../../realtime/ranked-matchmaking-keys.js';
import { getFreecrocoConfig } from '../../partner-config.js';

function configuredPartner(): { slug: string; pool: RankedPool } | null {
  try {
    const config = getFreecrocoConfig();
    return config ? { slug: config.slug, pool: `${config.slug}-${config.environment}` } : null;
  } catch {
    // Never the parser's message: it quotes the surrounding config text, keys included.
    logger.error({ code: 'partner_config_invalid' }, 'Partner config unreadable; partner ranked pool disabled');
    return null;
  }
}

/** The configured partner's ranked pool (`freecroco-test`), or null when no partner is configured. */
export function partnerRankedPool(): RankedPool | null {
  return configuredPartner()?.pool ?? null;
}

/**
 * The only pool this user may be queued in. A partner player can never enter the public pool; null means the
 * player's partner is not configured on this deploy (refuse the queue).
 */
export function rankedPoolForUser(user: { partner_slug?: string | null }): RankedPool | null {
  if (user.partner_slug == null) return PUBLIC_RANKED_POOL;
  const partner = configuredPartner();
  return partner && partner.slug === user.partner_slug ? partner.pool : null;
}

export function isPartnerRankedPool(pool: RankedPool): boolean {
  return pool !== PUBLIC_RANKED_POOL;
}

/** Pools the matchmaking tick serves. */
export function activeRankedPools(): RankedPool[] {
  const partner = partnerRankedPool();
  return partner ? [PUBLIC_RANKED_POOL, partner] : [PUBLIC_RANKED_POOL];
}

/**
 * KEYS for the cancel script: the public queue/timeouts and the user map first (its original shape), then every
 * other pool's queue/timeouts, so cancelling by user never needs to know the pool.
 */
export function rankedCancelSearchKeys(): string[] {
  const keys = [rankedPoolKeys(PUBLIC_RANKED_POOL).queue, rankedPoolKeys(PUBLIC_RANKED_POOL).timeouts, RANKED_MM_USER_MAP_KEY];
  for (const pool of activeRankedPools()) {
    if (pool === PUBLIC_RANKED_POOL) continue;
    const { queue, timeouts } = rankedPoolKeys(pool);
    keys.push(queue, timeouts);
  }
  return keys;
}
