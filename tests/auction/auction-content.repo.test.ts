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
    return '$param';
  }

  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((acc, part, index) => (
        acc + part + (index < values.length ? renderValue(values[index]) : '')
      ), '');
      const fragment = { text, values };

      if (/^\s*SELECT\b/i.test(text)) {
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
    expect(dbMocks.queryCalls[0].text).not.toContain('needs_review');
  });

  it('filters random selection by position and excludes already-used clue card ids', async () => {
    dbMocks.results.push([]);

    await auctionContentRepo.getRandomPublishedAuctionCard({
      locale: 'en',
      positionGroup: 'FWD',
      excludeClueCardIds: ['11111111-1111-1111-1111-111111111111'],
    });

    const query = dbMocks.queryCalls[0].text;
    expect(query).toContain("status = 'published'");
    expect(query).toContain('position_group = $param');
    expect(query).toContain('clue_card_id <> ALL(ARRAY_PARAM::uuid[])');
    expect(query).toContain('ORDER BY random()');
  });

  it('re-checks published eligibility when reading a card by id', async () => {
    dbMocks.results.push([]);

    await auctionContentRepo.getPublishedAuctionCardById('11111111-1111-1111-1111-111111111111');

    const query = dbMocks.queryCalls[0].text;
    expect(query).toContain("status = 'published'");
    expect(query).toContain('image_url IS NOT NULL');
    expect(query).toContain('current_value_eur IS NOT NULL');
    expect(query).toContain("position_group IN ('GK', 'DEF', 'MID', 'FWD')");
    expect(query).toContain('clue_card_id = $param');
  });
});
