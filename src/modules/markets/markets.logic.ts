/**
 * Markets: who a piece of content is for.
 *
 * Everything is for all markets unless it says otherwise. A category can name a
 * home market — everyone can still play it, and players in that market are
 * offered it more often — and can also be only for that market, in which case
 * players outside it are never offered it.
 *
 * Pure functions only; the definitions live in the `markets` table
 * (see markets.service.ts).
 */

export interface MarketDefinition {
  code: string;
  name: string;
  /** ISO 3166-1 alpha-2 codes, upper case. */
  countries: string[];
}

/** The two fields that scope a piece of content to a market. */
export interface MarketScope {
  market: string | null;
  market_only: boolean;
}

/**
 * How much more likely a home-market category is to be offered than any other
 * one, when a player in the match is from that market.
 */
export const HOME_MARKET_WEIGHT = 3;

export function marketForCountry(
  definitions: readonly MarketDefinition[],
  country: string | null | undefined
): string | null {
  const code = country?.trim().toUpperCase();
  if (!code) return null;
  return definitions.find((definition) => definition.countries.includes(code))?.code ?? null;
}

/**
 * Whether content may be offered to a group of players (one entry per player;
 * null = that player has no market).
 *
 * Content for all markets, or with only a home market, is always offered.
 * Market-only content is offered when every player is in its market — with
 * nobody to offer it to (an empty list) it is not.
 */
export function canOffer(scope: MarketScope, playerMarkets: ReadonlyArray<string | null>): boolean {
  if (!scope.market_only) return true;
  if (!scope.market || playerMarkets.length === 0) return false;
  return playerMarkets.every((market) => market === scope.market);
}

/** Whether this is home content for at least one of the players. */
export function isHome(scope: MarketScope, playerMarkets: ReadonlyArray<string | null>): boolean {
  return scope.market !== null && playerMarkets.includes(scope.market);
}

/**
 * Picks up to `count` rows at random for these players: rows they may not be
 * offered are left out, and home-market rows are HOME_MARKET_WEIGHT times as
 * likely to be drawn as the rest (weighted sampling without replacement,
 * Efraimidis–Spirakis). With no home rows this is a plain uniform shuffle.
 */
export function pickForMarkets<T extends MarketScope>(
  rows: readonly T[],
  count: number,
  playerMarkets: ReadonlyArray<string | null>,
  random: () => number
): T[] {
  if (count <= 0) return [];
  return rows
    .filter((row) => canOffer(row, playerMarkets))
    .map((row) => {
      const weight = isHome(row, playerMarkets) ? HOME_MARKET_WEIGHT : 1;
      // 1 - random() is in (0, 1], so the key is never 0^x for a real draw.
      return { row, key: Math.pow(1 - random(), 1 / weight) };
    })
    .sort((a, b) => b.key - a.key)
    .slice(0, count)
    .map((entry) => entry.row);
}

/** Home-market rows first, keeping the existing order inside each group. */
export function homeFirst<T extends MarketScope>(rows: readonly T[], market: string | null): T[] {
  if (!market) return [...rows];
  return [...rows.filter((row) => row.market === market), ...rows.filter((row) => row.market !== market)];
}
