import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const dbMocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), {
    begin: vi.fn(),
    array: vi.fn(),
  });
  return { sql };
});

vi.mock('../../src/db/index.js', () => ({ sql: dbMocks.sql }));

import { rankedRepo } from '../../src/modules/ranked/ranked.repo.js';

describe('ranked archived reads', () => {
  beforeEach(() => dbMocks.sql.mockReset());

  it('returns null when the user has no eligible archived row in the batch', async () => {
    dbMocks.sql.mockResolvedValue([]);

    const result = await rankedRepo.getArchivedUserRank(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111'
    );

    expect(result).toBeNull();
  });
});
