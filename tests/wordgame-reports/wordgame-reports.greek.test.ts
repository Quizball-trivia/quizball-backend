import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

const repo = vi.hoisted(() => ({ file: vi.fn(async () => true) }));
vi.mock('../../src/modules/wordgame-reports/wordgame-reports.repo.js', () => ({ wordgameReportsRepo: { file: repo.file } }));
vi.mock('../../src/modules/content-gaps/content-gaps.recorder.js', () => ({ contentGaps: { record: vi.fn() } }));

import { wordgameReportsService } from '../../src/modules/wordgame-reports/wordgame-reports.service.js';

const base = { game: 'name_chain' as const, source: 'daily' as const, contextId: 'run-1', round: 0, reporter: { userId: 'u-1' } };
const refusal = { release: 'rel-1', subject: null, resolvedPid: null };

describe('"that was right" reports keep Greek text', () => {
  it('stores a Greek name with its Greek compared form (accents dropped, final sigma as σ)', async () => {
    // An invented name.
    await wordgameReportsService.file(base, refusal, '  Ζήνων   Πέτρος ');
    expect(repo.file).toHaveBeenCalledWith(expect.objectContaining({ typed: 'Ζήνων Πέτρος', norm: 'ζηνων πετροσ' }), expect.any(Number));
  });

  it('still drops a text with nothing to read', async () => {
    repo.file.mockClear();
    await wordgameReportsService.file(base, refusal, '·;·');
    expect(repo.file).not.toHaveBeenCalled();
  });
});
