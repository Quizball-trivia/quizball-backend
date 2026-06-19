import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const dbMocks = vi.hoisted(() => {
  const unsafe = vi.fn();
  const begin = vi.fn(async (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) =>
    fn({ unsafe })
  );
  const sql = Object.assign(vi.fn(() => ({})), {
    begin,
    array: (values: unknown[]) => values,
  });

  return { begin, sql, unsafe };
});

vi.mock('../../src/db/index.js', () => ({
  sql: dbMocks.sql,
}));

import { auctionRepo } from '../../src/modules/auction/auction.repo.js';

const CARD_ID = '11111111-1111-1111-1111-111111111111';

describe('auctionRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates card fields and replaces clues inside one transaction, propagating clue insert failure', async () => {
    dbMocks.unsafe.mockImplementation(async (query: string) => {
      if (query.includes('UPDATE auction_cards')) {
        return [{ id: CARD_ID }];
      }
      if (query.includes('DELETE FROM auction_card_clues')) {
        return [];
      }
      if (query.includes('INSERT INTO auction_card_clues')) {
        throw new Error('insert failed');
      }
      return [];
    });

    await expect(
      auctionRepo.updateCardAndReplaceClues(CARD_ID, {
        true_value_eur: 100_000_000,
        clues: [
          { clue_order: 1, clue_en: 'A', clue_ka: 'ა', clue_kind: 'fact', supported_fact_ids: [] },
          { clue_order: 2, clue_en: 'B', clue_ka: 'ბ', clue_kind: 'fact', supported_fact_ids: [] },
          { clue_order: 3, clue_en: 'C', clue_ka: 'გ', clue_kind: 'fact', supported_fact_ids: [] },
        ],
      })
    ).rejects.toThrow('insert failed');

    expect(dbMocks.begin).toHaveBeenCalledTimes(1);
    expect(dbMocks.unsafe).toHaveBeenCalledTimes(3);
    expect(dbMocks.unsafe.mock.calls[0][0]).toContain('UPDATE auction_cards');
    expect(dbMocks.unsafe.mock.calls[1][0]).toContain('DELETE FROM auction_card_clues');
    expect(dbMocks.unsafe.mock.calls[2][0]).toContain('INSERT INTO auction_card_clues');
  });
});
