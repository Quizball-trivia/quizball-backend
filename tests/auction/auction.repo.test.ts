import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

type SqlFragment = {
  text: string;
  values: unknown[];
};

const dbMocks = vi.hoisted(() => {
  const taggedCalls: SqlFragment[] = [];
  const unsafeCalls: { query: string; params: unknown[] }[] = [];
  const taggedResults: unknown[][] = [];
  const unsafeResults: unknown[][] = [];

  function renderValue(value: unknown): string {
    if (value && typeof value === 'object' && 'text' in value) {
      return (value as SqlFragment).text;
    }
    return '$param';
  }

  const unsafe = vi.fn((query: string, params: unknown[] = []) => {
    unsafeCalls.push({ query, params });
    return Promise.resolve(unsafeResults.shift() ?? []);
  });

  const begin = vi.fn(async (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) =>
    fn({ unsafe })
  );

  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce(
        (acc, part, index) => acc + part + (index < values.length ? renderValue(values[index]) : ''),
        ''
      );
      const fragment = { text, values };

      // SELECT / UPDATE ... RETURNING are awaited queries; bare fragments
      // (filters, cardSelect) are returned for interpolation.
      if (/^\s*(SELECT|UPDATE)\b/i.test(text)) {
        taggedCalls.push(fragment);
        return Promise.resolve(taggedResults.shift() ?? []);
      }

      return fragment;
    }),
    {
      begin,
      unsafe,
      array: (values: unknown[]) => values,
    }
  );

  return { taggedCalls, unsafeCalls, taggedResults, unsafeResults, begin, unsafe, sql };
});

vi.mock('../../src/db/index.js', () => ({
  sql: dbMocks.sql,
}));

import { auctionRepo } from '../../src/modules/auction/auction.repo.js';

const CARD_ID = '11111111-1111-1111-1111-111111111111';
const PLAYER_ID = '22222222-2222-2222-2222-222222222222';

const viewRow = {
  id: CARD_ID,
  player_id: '22222222-2222-2222-2222-222222222222',
  position_group: 'FWD',
  true_value_eur: 100_000_000,
  starting_price_eur: 20_000_000,
  value_type: 'current',
  card_type: 'normal',
  difficulty: 'medium',
  status: 'needs_review',
  verification_status: 'needs_review',
  p_name: 'Lionel Messi',
  created_at: '2026-06-19T00:00:00.000Z',
  updated_at: '2026-06-19T00:00:00.000Z',
};

describe('auctionRepo (player_clue_cards backend)', () => {
  beforeEach(() => {
    dbMocks.taggedCalls.length = 0;
    dbMocks.unsafeCalls.length = 0;
    dbMocks.taggedResults.length = 0;
    dbMocks.unsafeResults.length = 0;
    vi.clearAllMocks();
  });

  it('lists cards from player_clue_card_content_view with name/club/nationality search', async () => {
    dbMocks.taggedResults.push([viewRow]); // cards query
    dbMocks.taggedResults.push([{ total: '1' }]); // count query

    const result = await auctionRepo.listCards({ status: 'needs_review', search: 'Messi' }, 1, 50);

    expect(result.total).toBe(1);
    expect(result.cards).toHaveLength(1);

    const listQuery = dbMocks.taggedCalls[0].text;
    expect(listQuery).toContain('player_clue_card_content_view');
    expect(listQuery).not.toContain('auction_cards');
    expect(listQuery).not.toContain('auction_card_clues');
    expect(listQuery).toContain('v.name ILIKE');
    expect(listQuery).toContain('v.current_club');
    expect(listQuery).toContain('v.nationality');
    expect(listQuery).toContain('3 AS clue_count');
  });

  it('reads card detail from the content view by clue_card_id', async () => {
    dbMocks.taggedResults.push([viewRow]);

    const detail = await auctionRepo.getCardDetail(CARD_ID);

    expect(detail).not.toBeNull();
    const query = dbMocks.taggedCalls[0].text;
    expect(query).toContain('player_clue_card_content_view');
    expect(query).toContain('v.clue_card_id = $param');
  });

  it('shapes en clues + ka sibling clues into ordered clue rows', async () => {
    // First query returns the en card row; second returns the ka sibling clues.
    dbMocks.taggedResults.push([
      { clue_1: 'First', clue_2: 'Second', clue_3: 'Third', locale: 'en', football_player_id: PLAYER_ID },
    ]);
    dbMocks.taggedResults.push([{ clue_1: 'Pirveli', clue_2: 'Meore', clue_3: 'Mesame' }]);

    const clues = await auctionRepo.getClues(CARD_ID);

    expect(dbMocks.taggedCalls[0].text).toContain('clue_1, clue_2, clue_3');
    expect(dbMocks.taggedCalls[0].text).toContain('player_clue_cards');
    expect(clues).toHaveLength(3);
    expect(clues.map((c) => c.clue_order)).toEqual([1, 2, 3]);
    expect(clues.map((c) => c.clue_en)).toEqual(['First', 'Second', 'Third']);
    expect(clues.map((c) => c.clue_ka)).toEqual(['Pirveli', 'Meore', 'Mesame']);
    expect(clues.every((c) => c.clue_kind === 'fact')).toBe(true);
  });

  it('returns no clues when the card row is missing', async () => {
    dbMocks.taggedResults.push([]);
    const clues = await auctionRepo.getClues(CARD_ID);
    expect(clues).toEqual([]);
  });

  it('updates the en inline clues + ka sibling on player_clue_cards', async () => {
    dbMocks.unsafeResults.push([{ id: CARD_ID }]); // UPDATE en ... RETURNING id
    dbMocks.unsafeResults.push([]); // UPDATE ka sibling
    dbMocks.taggedResults.push([viewRow]); // getCardDetail reload

    const updated = await auctionRepo.updateCardAndReplaceClues(CARD_ID, {
      difficulty: 'hard',
      clues: [
        { clue_order: 1, clue_en: 'A', clue_ka: 'ა', clue_kind: 'fact', supported_fact_ids: [] },
        { clue_order: 2, clue_en: 'B', clue_ka: 'ბ', clue_kind: 'fact', supported_fact_ids: [] },
        { clue_order: 3, clue_en: 'C', clue_ka: 'გ', clue_kind: 'fact', supported_fact_ids: [] },
      ],
    });

    expect(updated).not.toBeNull();
    expect(dbMocks.begin).toHaveBeenCalledTimes(1);
    // One UPDATE for the en row, one for the ka sibling.
    expect(dbMocks.unsafe).toHaveBeenCalledTimes(2);

    const updateQuery = dbMocks.unsafe.mock.calls[0][0] as string;
    expect(updateQuery).toContain('UPDATE player_clue_cards');
    expect(updateQuery).toContain('clue_1');
    expect(updateQuery).toContain('clue_2');
    expect(updateQuery).toContain('clue_3');
    // The second call targets the ka sibling.
    const kaQuery = dbMocks.unsafe.mock.calls[1][0] as string;
    expect(kaQuery).toContain("locale = 'ka'");
    expect(updateQuery).toContain('difficulty');
    expect(updateQuery).not.toContain('auction_card_clues');

    const params = dbMocks.unsafe.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(CARD_ID);
    expect(params[2]).toBe('A');
    expect(params[4]).toBe('B');
    expect(params[6]).toBe('C');
  });

  it('returns null when updating a non-existent card', async () => {
    dbMocks.unsafeResults.push([]); // UPDATE returns no rows

    const updated = await auctionRepo.updateCardAndReplaceClues(CARD_ID, { difficulty: 'easy' });

    expect(updated).toBeNull();
    expect(dbMocks.unsafe).toHaveBeenCalledTimes(1);
  });

  it('updates status against player_clue_cards and reloads detail', async () => {
    dbMocks.unsafeResults.push([{ id: CARD_ID, locale: 'en', football_player_id: PLAYER_ID }]); // en UPDATE ... RETURNING
    dbMocks.unsafeResults.push([]); // ka sibling auto-publish UPDATE
    dbMocks.taggedResults.push([viewRow]); // getCardDetail reload

    const result = await auctionRepo.updateStatus(CARD_ID, 'published', 'admin-uuid', { force: true });

    expect(result).not.toBeNull();
    expect(dbMocks.begin).toHaveBeenCalledTimes(1);
    const updateQuery = dbMocks.unsafeCalls[0].query;
    expect(updateQuery).toContain('UPDATE player_clue_cards');
    expect(updateQuery).toContain('status = $2');
    expect(updateQuery).not.toContain('auction_cards');
  });

  it('also publishes the ka sibling when an en card is published (same transaction)', async () => {
    dbMocks.unsafeResults.push([{ id: CARD_ID, locale: 'en', football_player_id: PLAYER_ID }]); // en UPDATE
    dbMocks.unsafeResults.push([]); // ka sibling UPDATE
    dbMocks.taggedResults.push([viewRow]); // getCardDetail reload

    const result = await auctionRepo.updateStatus(CARD_ID, 'published', 'admin-uuid');

    expect(result).not.toBeNull();
    expect(dbMocks.begin).toHaveBeenCalledTimes(1);
    // Both writes happen inside the one transaction: en UPDATE + ka sibling UPDATE.
    expect(dbMocks.unsafe).toHaveBeenCalledTimes(2);

    // First unsafe call: the en card UPDATE keyed by id ($1).
    const enUpdate = dbMocks.unsafeCalls[0];
    expect(enUpdate.query).toContain('UPDATE player_clue_cards');
    expect(enUpdate.query).toContain('WHERE id = $1');
    expect(enUpdate.params[0]).toBe(CARD_ID);
    expect(enUpdate.params[1]).toBe('published');

    // Second unsafe call: the ka sibling UPDATE keyed by football_player_id + locale.
    const kaUpdate = dbMocks.unsafeCalls[1];
    expect(kaUpdate.query).toContain('UPDATE player_clue_cards');
    expect(kaUpdate.query).toContain("status = 'published'");
    expect(kaUpdate.query).toContain('WHERE football_player_id = $1');
    expect(kaUpdate.query).toContain("locale = 'ka'");
    expect(kaUpdate.query).toContain("status <> 'published'"); // idempotent guard
    expect(kaUpdate.params[0]).toBe(PLAYER_ID);
  });

  it('does NOT touch a ka sibling for non-publish status changes on an en card', async () => {
    dbMocks.unsafeResults.push([{ id: CARD_ID, locale: 'en', football_player_id: PLAYER_ID }]); // en UPDATE
    dbMocks.taggedResults.push([viewRow]); // getCardDetail reload

    const result = await auctionRepo.updateStatus(CARD_ID, 'approved');

    expect(result).not.toBeNull();
    // Only the single en UPDATE ran inside the transaction; no sibling UPDATE.
    expect(dbMocks.unsafe).toHaveBeenCalledTimes(1);
    const siblingUpdates = dbMocks.unsafeCalls.filter((c) => c.query.includes("locale = 'ka'"));
    expect(siblingUpdates).toHaveLength(0);
  });

  it('does NOT propagate when a ka card is published directly (single-row update)', async () => {
    dbMocks.unsafeResults.push([{ id: CARD_ID, locale: 'ka', football_player_id: PLAYER_ID }]); // ka UPDATE
    dbMocks.taggedResults.push([viewRow]); // getCardDetail reload

    const result = await auctionRepo.updateStatus(CARD_ID, 'published');

    expect(result).not.toBeNull();
    // The source row is ka, so the sibling-publish branch is skipped: one write only.
    expect(dbMocks.unsafe).toHaveBeenCalledTimes(1);
    const siblingUpdates = dbMocks.unsafeCalls.filter((c) => c.query.includes("locale = 'ka'"));
    expect(siblingUpdates).toHaveLength(0);
  });

  it('returns null when updating status of a missing card', async () => {
    dbMocks.unsafeResults.push([]); // en UPDATE returns no rows

    const result = await auctionRepo.updateStatus(CARD_ID, 'approved');

    expect(result).toBeNull();
    expect(dbMocks.unsafe).toHaveBeenCalledTimes(1);
  });
});
