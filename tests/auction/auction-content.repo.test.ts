import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

type SqlFragment = {
  text: string;
  values: unknown[];
};

const dbMocks = vi.hoisted(() => {
  const queryCalls: SqlFragment[] = [];
  const results: unknown[][] = [];

  function renderValue(value: unknown): string {
    if (value && typeof value === 'object' && 'text' in value) {
      return (value as SqlFragment).text;
    }
    if (value && typeof value === 'object' && '__array' in value) {
      return 'ARRAY_PARAM';
    }
    if (value && typeof value === 'object' && '__rows' in value) {
      return `ROWS(${JSON.stringify((value as { __rows: unknown[] }).__rows)})`;
    }
    return '$param';
  }

  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
      // sql(rows) helper form (bulk INSERT values) — not a tagged template.
      if (!Array.isArray((strings as TemplateStringsArray).raw)) {
        return { __rows: strings as unknown[] };
      }
      const text = (strings as TemplateStringsArray).reduce((acc, part, index) => (
        acc + part + (index < values.length ? renderValue(values[index]) : '')
      ), '');
      const fragment = { text, values };

      if (/^\s*SELECT\b/i.test(text) || /^\s*INSERT\b/i.test(text)) {
        queryCalls.push(fragment);
        return Promise.resolve(results.shift() ?? []);
      }

      return fragment;
    }),
    {
      array: (values: unknown[]) => ({ __array: values }),
    }
  );

  return { queryCalls, results, sql };
});

vi.mock('../../src/db/index.js', () => ({
  sql: dbMocks.sql,
}));

import { auctionContentRepo } from '../../src/modules/auction/auction-content.repo.js';

describe('auctionContentRepo', () => {
  beforeEach(() => {
    dbMocks.queryCalls.length = 0;
    dbMocks.results.length = 0;
    vi.clearAllMocks();
  });

  it('counts only published eligible cards with available true and starting prices', async () => {
    dbMocks.results.push([{ count: '7' }]);

    await expect(auctionContentRepo.getPublishedCardCount('en')).resolves.toBe(7);

    const query = dbMocks.queryCalls[0].text;
    expect(query).toContain("status = 'published'");
    expect(query).toContain("active_status = 'active'");
    expect(query).toContain('image_url IS NOT NULL');
    expect(query).toContain('current_value_eur IS NOT NULL');
    expect(query).toContain("position_group IN ('GK', 'DEF', 'MID', 'FWD')");
    expect(query).toContain('auction_price_eur IS NOT NULL');
    expect(query).toContain('starting_price_eur IS NOT NULL');
    expect(query).toContain('locale = $param');
  });

  it('checks availability without considering needs_review content usable', async () => {
    dbMocks.results.push([{ base_count: '2', usable_count: '1', missing_price_count: '1' }]);

    const result = await auctionContentRepo.getPublishedCardAvailability('en');

    expect(result).toEqual({ base_count: 2, usable_count: 1, missing_price_count: 1 });
    expect(dbMocks.queryCalls[0].text).toContain("status = 'published'");
    expect(dbMocks.queryCalls[0].text).toContain("active_status = 'active'");
    expect(dbMocks.queryCalls[0].text).not.toContain('needs_review');
  });

  it('resolves used card ids to footballers before applying the in-match exclusion', async () => {
    dbMocks.results.push([]);

    await auctionContentRepo.getRandomPublishedAuctionCard({
      locale: 'en',
      positionGroup: 'FWD',
      excludeClueCardIds: ['11111111-1111-1111-1111-111111111111'],
    });

    const query = dbMocks.queryCalls[0].text;
    expect(query).toContain("status = 'published'");
    expect(query).toContain("active_status = 'active'");
    expect(query).toContain('position_group = $param');
    expect(query).toContain('football_player_id NOT IN');
    expect(query).toContain('FROM player_clue_cards used');
    expect(query).toContain('used.id = ANY(ARRAY_PARAM::uuid[])');
    expect(query).toMatch(/ORDER BY\s+random\(\)/);
  });

  it('excludes recently-seen footballers across locales/variants alongside in-match card ids', async () => {
    dbMocks.results.push([]);

    await auctionContentRepo.getRandomPublishedAuctionCard({
      locale: 'en',
      positionGroup: 'FWD',
      excludeClueCardIds: ['11111111-1111-1111-1111-111111111111'],
      excludeRecentlySeenFootballPlayerIds: ['33333333-3333-3333-3333-333333333333'],
    });

    const query = dbMocks.queryCalls[0].text;
    // Both exclusions are independent filters — history never replaces in-match.
    expect(query).toContain('football_player_id NOT IN');
    expect(query).toContain('football_player_id <> ALL(ARRAY_PARAM::uuid[])');
  });

  it('orders an exhausted-pool fallback by least-recently-seen footballer', async () => {
    dbMocks.results.push([]);

    await auctionContentRepo.getRandomPublishedAuctionCard({
      locale: 'en',
      positionGroup: 'FWD',
      preferLeastRecentlySeenFootballPlayerIds: [
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444',
      ],
    });

    const query = dbMocks.queryCalls[0].text;
    expect(query).not.toContain('football_player_id <> ALL');
    expect(query).toContain(
      'array_position(ARRAY_PARAM::uuid[], football_player_id) ASC NULLS LAST'
    );
    expect(query).toContain('random()');
  });

  it('keeps selection difficulty-agnostic unless a preference is supplied', async () => {
    dbMocks.results.push([]);

    await auctionContentRepo.getRandomPublishedAuctionCard({ locale: 'en', positionGroup: 'FWD' });

    const query = dbMocks.queryCalls[0].text;
    expect(query).not.toContain('prompt_version');
    expect(query).toContain('ORDER BY');
    expect(query).toContain('random()');
  });

  it('biases selection toward the matching rich prompt version when a difficulty is preferred', async () => {
    dbMocks.results.push([]);

    await auctionContentRepo.getRandomPublishedAuctionCard({
      locale: 'en',
      positionGroup: 'FWD',
      preferredDifficulty: 'hard',
    });

    const query = dbMocks.queryCalls[0].text;
    // Soft ORDER BY bias, not a hard WHERE — a pool with no v3-rich cards still returns one.
    expect(query).toContain('prompt_version LIKE');
    expect(query).not.toContain('WHERE prompt_version');
    expect(query).toContain('random()');
  });

  it('joins seen cards to players and returns least-recently-seen footballers first', async () => {
    dbMocks.results.push([
      { football_player_id: '33333333-3333-3333-3333-333333333333' },
      { football_player_id: '44444444-4444-4444-4444-444444444444' },
    ]);

    const result = await auctionContentRepo.getRecentlySeenFootballPlayerIds(
      ['55555555-5555-5555-5555-555555555555'],
      14
    );

    expect(result).toEqual([
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
    ]);
    const query = dbMocks.queryCalls[0].text;
    expect(query).toContain('FROM auction_seen_cards');
    expect(query).toContain('JOIN player_clue_cards pcc');
    expect(query).toContain('pcc.id = seen.clue_card_id');
    expect(query).toContain('seen.user_id = ANY(ARRAY_PARAM::uuid[])');
    expect(query).toContain('seen.seen_at > now() - make_interval(days => $param)');
    expect(query).toContain('GROUP BY pcc.football_player_id');
    expect(query).toContain('ORDER BY MAX(seen.seen_at) ASC');
  });

  it('skips the recently-seen query entirely when there are no human users', async () => {
    await expect(auctionContentRepo.getRecentlySeenFootballPlayerIds([], 14)).resolves.toEqual([]);
    expect(dbMocks.queryCalls).toHaveLength(0);
  });

  it('records a seen card for every human participant and bumps seen_at on repeat', async () => {
    dbMocks.results.push([]);

    await auctionContentRepo.recordSeenClueCards(
      ['55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666'],
      ['33333333-3333-3333-3333-333333333333']
    );

    const query = dbMocks.queryCalls[0].text;
    expect(query).toContain('INSERT INTO auction_seen_cards');
    expect(query).toContain('ON CONFLICT (user_id, clue_card_id) DO UPDATE SET seen_at = NOW()');
    // One row per (user, card) pair — both humans get their own history entry.
    expect(query).toContain('"user_id":"55555555-5555-5555-5555-555555555555"');
    expect(query).toContain('"user_id":"66666666-6666-6666-6666-666666666666"');
    expect(query).toContain('"clue_card_id":"33333333-3333-3333-3333-333333333333"');
  });

  it('writes nothing when there are no humans or no cards to record', async () => {
    await auctionContentRepo.recordSeenClueCards([], ['33333333-3333-3333-3333-333333333333']);
    await auctionContentRepo.recordSeenClueCards(['55555555-5555-5555-5555-555555555555'], []);

    expect(dbMocks.queryCalls).toHaveLength(0);
  });

  it('re-checks published eligibility when reading a card by id', async () => {
    dbMocks.results.push([]);

    await auctionContentRepo.getPublishedAuctionCardById('11111111-1111-1111-1111-111111111111');

    const query = dbMocks.queryCalls[0].text;
    expect(query).toContain("status = 'published'");
    expect(query).toContain("active_status = 'active'");
    expect(query).toContain('image_url IS NOT NULL');
    expect(query).toContain('current_value_eur IS NOT NULL');
    expect(query).toContain("position_group IN ('GK', 'DEF', 'MID', 'FWD')");
    expect(query).toContain('clue_card_id = $param');
  });
});
