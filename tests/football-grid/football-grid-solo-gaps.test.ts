import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  diagnose: vi.fn(async () => ({ reason: 'recognized_not_in_cell', playerId: 'p1', candidatePlayerIds: ['p1'], revision: 'rev1' })),
}));
vi.mock('../../src/modules/content-gaps/content-gaps.recorder.js', () => ({ contentGaps: { record: mocks.record } }));
vi.mock('../../src/modules/football-grid/football-grid-solo.service.js', () => ({ footballGridSoloService: { diagnose: mocks.diagnose } }));

import { __test, noteSoloGap } from '../../src/modules/football-grid/football-grid-solo-gaps.js';

const BOARD = '00000000-0000-4000-8000-0000000000b1';
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('solo Tic Tac Toe content gaps', () => {
  beforeEach(() => { vi.clearAllMocks(); __test.dedupe.reset(); });

  it('records a refused typed name as football_grid practice, keyed by board cell', async () => {
    noteSoloGap({ boardId: BOARD, cellIndex: 4, text: 'Aro Bandle' });
    await flush();
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({
      game: 'football_grid', mode: 'practice', boardKey: `${BOARD}#4`, context: `${BOARD}|rev1`, verdict: 'miss', text: 'Aro Bandle', resolvedId: 'p1',
    }));
  });

  it('counts the same name on the same cell once per two minutes; blank text never', async () => {
    noteSoloGap({ boardId: BOARD, cellIndex: 4, text: 'Aro Bandle' });
    noteSoloGap({ boardId: BOARD, cellIndex: 4, text: ' aro bandle ' });
    noteSoloGap({ boardId: BOARD, cellIndex: 4, text: 'Áro-Bandle' });
    noteSoloGap({ boardId: BOARD, cellIndex: 5, text: 'Aro Bandle' });
    noteSoloGap({ boardId: BOARD, cellIndex: 6, text: '  ' });
    await flush();
    expect(mocks.diagnose).toHaveBeenCalledTimes(2);
    expect(__test.dedupe.fresh(`${BOARD}#4`, 'aro bandle', Date.now() + 2 * 60_000 + 1)).toBe(true);
  });

  it('a reason that is not a content question (already used, accepted) records nothing; a failing diagnosis is swallowed', async () => {
    mocks.diagnose.mockResolvedValueOnce({ reason: 'accepted', playerId: 'p1', candidatePlayerIds: [], revision: 'r' });
    noteSoloGap({ boardId: BOARD, cellIndex: 1, text: 'x1' });
    mocks.diagnose.mockRejectedValueOnce(new Error('boom'));
    noteSoloGap({ boardId: BOARD, cellIndex: 2, text: 'x2' });
    await flush();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
