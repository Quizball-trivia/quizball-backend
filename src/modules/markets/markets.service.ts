import { logger } from '../../core/logger.js';
import { getCurrentCountriesForUsers } from '../../realtime/session-country.js';
import { marketForCountry, type MarketDefinition } from './markets.logic.js';
import { marketsRepo } from './markets.repo.js';

// Markets change a few times a year at most; the short TTL only bounds how
// long a new market takes to reach every instance.
const DEFINITIONS_TTL_MS = 5 * 60 * 1000;

let cache: { definitions: MarketDefinition[]; expiresAt: number } | null = null;

async function definitions(): Promise<MarketDefinition[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.definitions;
  const rows = await marketsRepo.list();
  cache = { definitions: rows, expiresAt: now + DEFINITIONS_TTL_MS };
  return rows;
}

export function invalidateMarketsCache(): void {
  cache = null;
}

/**
 * Every lookup here fails closed: if markets cannot be read, players are
 * treated as having no market. They then get everything that is for all
 * markets — never content that is only for a market they may not be in — and
 * a match or a list never fails because of this feature.
 */
export const marketsService = {
  async list(): Promise<MarketDefinition[]> {
    return definitions();
  },

  /** The market of one country, or null when it belongs to none. */
  async forCountry(country: string | null | undefined): Promise<string | null> {
    if (!country) return null;
    try {
      return marketForCountry(await definitions(), country);
    } catch (error) {
      logger.warn({ error }, 'Market lookup failed; treating the player as having no market');
      return null;
    }
  },

  /**
   * One entry per real player in `userIds` (bots are left out): the market of
   * their profile country, else of the country they are playing from, else null.
   */
  async forPlayers(userIds: string[]): Promise<Array<string | null>> {
    const unique = [...new Set(userIds)].filter(Boolean);
    if (unique.length === 0) return [];
    try {
      const [defs, players] = await Promise.all([definitions(), marketsRepo.listPlayerCountries(unique)]);
      const withoutCountry = players.filter((player) => !player.country).map((player) => player.id);
      const current = withoutCountry.length > 0
        ? await getCurrentCountriesForUsers(withoutCountry)
        : new Map<string, string>();
      return players.map((player) => marketForCountry(defs, player.country ?? current.get(player.id)));
    } catch (error) {
      logger.warn({ error, userIds: unique }, 'Market lookup failed; treating players as having no market');
      return unique.map(() => null);
    }
  },
};
