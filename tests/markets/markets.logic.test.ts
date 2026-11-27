import { describe, expect, it } from 'vitest';
import {
  HOME_MARKET_WEIGHT,
  canOffer,
  homeFirst,
  isHome,
  marketForCountry,
  pickForMarkets,
  type MarketDefinition,
} from '../../src/modules/markets/markets.logic.js';

const DEFINITIONS: MarketDefinition[] = [
  { code: 'ge', name: 'Georgia', countries: ['GE'] },
  { code: 'uk', name: 'United Kingdom', countries: ['GB'] },
];

const everyone = { id: 'everyone', market: null, market_only: false };
const ukHome = { id: 'uk-home', market: 'uk', market_only: false };
const geHome = { id: 'ge-home', market: 'ge', market_only: false };
const geOnly = { id: 'ge-only', market: 'ge', market_only: true };

/** A deterministic generator in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('marketForCountry', () => {
  it('maps a country to the market that lists it, whatever the letter case', () => {
    expect(marketForCountry(DEFINITIONS, 'GE')).toBe('ge');
    expect(marketForCountry(DEFINITIONS, ' gb ')).toBe('uk');
  });

  it('gives no market to a country outside every market, or to no country', () => {
    expect(marketForCountry(DEFINITIONS, 'DE')).toBeNull();
    expect(marketForCountry(DEFINITIONS, null)).toBeNull();
    expect(marketForCountry(DEFINITIONS, '')).toBeNull();
  });
});

describe('canOffer', () => {
  it('offers content for all markets, and home-market content, to anyone', () => {
    for (const players of [[], [null], ['ge'], ['uk', 'ge']] as Array<Array<string | null>>) {
      expect(canOffer(everyone, players)).toBe(true);
      expect(canOffer(ukHome, players)).toBe(true);
    }
  });

  it('offers market-only content only when every player is in that market', () => {
    expect(canOffer(geOnly, ['ge'])).toBe(true);
    expect(canOffer(geOnly, ['ge', 'ge'])).toBe(true);
    expect(canOffer(geOnly, ['ge', 'uk'])).toBe(false);
    expect(canOffer(geOnly, ['ge', null])).toBe(false);
    expect(canOffer(geOnly, [null])).toBe(false);
  });

  it('does not offer market-only content when no player is known', () => {
    expect(canOffer(geOnly, [])).toBe(false);
  });

  it('does not offer market-only content that names no market', () => {
    expect(canOffer({ market: null, market_only: true }, [null])).toBe(false);
  });
});

describe('isHome', () => {
  it('is true when at least one player is in the content market', () => {
    expect(isHome(geHome, ['uk', 'ge'])).toBe(true);
    expect(isHome(geHome, ['uk', null])).toBe(false);
    expect(isHome(everyone, [null])).toBe(false);
  });
});

describe('pickForMarkets', () => {
  const pool = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `all-${i}`, market: null, market_only: false })),
    geHome,
    geOnly,
    ukHome,
  ];

  it('never draws market-only content for players outside the market', () => {
    const random = seeded(7);
    for (let round = 0; round < 300; round++) {
      const ids = pickForMarkets(pool, 3, ['uk'], random).map((row) => row.id);
      expect(ids).not.toContain('ge-only');
      const mixed = pickForMarkets(pool, 3, ['ge', 'uk'], random).map((row) => row.id);
      expect(mixed).not.toContain('ge-only');
    }
  });

  it('can draw everything the players may be offered, without repeats', () => {
    const picked = pickForMarkets(pool, 100, ['ge'], seeded(3));
    expect(picked).toHaveLength(pool.length);
    expect(new Set(picked.map((row) => row.id)).size).toBe(pool.length);
    expect(pickForMarkets(pool, 100, ['uk'], seeded(3))).toHaveLength(pool.length - 1);
  });

  it('draws home-market content more often for a player in that market', () => {
    const rounds = 4000;
    const count = (markets: Array<string | null>, id: string) => {
      const random = seeded(11);
      let hits = 0;
      for (let round = 0; round < rounds; round++) {
        if (pickForMarkets(pool, 3, markets, random).some((row) => row.id === id)) hits++;
      }
      return hits;
    };
    const atHome = count(['ge'], 'ge-home');
    const away = count(['uk'], 'ge-home');
    // A single draw is HOME_MARKET_WEIGHT times as likely; over three cards the
    // ratio is a little lower, so only a clear gap is asserted.
    expect(HOME_MARKET_WEIGHT).toBeGreaterThan(1);
    expect(atHome).toBeGreaterThan(away * 1.8);
    expect(away).toBeGreaterThan(0);
  });

  it('draws uniformly when nothing is home content for the players', () => {
    const random = seeded(5);
    const hits = new Map<string, number>();
    const flat = pool.filter((row) => !row.market_only);
    const rounds = 6000;
    for (let round = 0; round < rounds; round++) {
      for (const row of pickForMarkets(flat, 1, [null], random)) {
        hits.set(row.id, (hits.get(row.id) ?? 0) + 1);
      }
    }
    const expected = rounds / flat.length;
    for (const row of flat) {
      expect(hits.get(row.id) ?? 0).toBeGreaterThan(expected * 0.7);
      expect(hits.get(row.id) ?? 0).toBeLessThan(expected * 1.3);
    }
  });

  it('returns nothing for a count of zero', () => {
    expect(pickForMarkets(pool, 0, ['ge'], seeded(1))).toEqual([]);
  });
});

describe('homeFirst', () => {
  it('puts the home market first and keeps the order inside each group', () => {
    const rows = [everyone, ukHome, geHome, geOnly];
    expect(homeFirst(rows, 'ge').map((row) => row.id)).toEqual(['ge-home', 'ge-only', 'everyone', 'uk-home']);
    expect(homeFirst(rows, null)).toEqual(rows);
  });
});
