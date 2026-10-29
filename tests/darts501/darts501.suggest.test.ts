import { describe, expect, it, vi } from 'vitest';
import { directory } from './fixture.js';

vi.mock('../../src/db/index.js', () => ({ sql: vi.fn(async () => []) }));
vi.mock('../../src/modules/tenable/tenable.directories.js', () => ({
  // A cold replica: nothing loaded yet, so suggestions are only served for releases some game uses.
  tenableDirectories: { loaded: () => false, get: async () => directory },
}));
vi.mock('../../src/modules/tenable-daily/tenable-daily.service.js', () => ({ tenableDailyContent: { get: async () => new Map() }, tenableRoomPairs: async () => [] }));
vi.mock('../../src/modules/darts501-daily/darts501-daily.service.js', () => ({
  darts501DailyContent: { get: async () => new Map([['2026-11-01', { category: { release: 'rel' } }]]) },
  darts501RoomPairs: async () => [{ release: 'pool-rel', coverage: 'cov' }],
}));

const { suggest } = await import('../../src/modules/tenable/tenable.suggest.js');

describe('suggestions for Football Darts 501', () => {
  it('a release only Darts 501 uses is served on a cold replica (days and room pool)', async () => {
    expect((await suggest('player', 'rel', 'Aro')).map((s) => s.eid)).toContain('p0');
    expect((await suggest('player', 'pool-rel', 'Aro')).length).toBeGreaterThan(0);
  });
  it('a release nothing uses gets nothing', async () => {
    expect(await suggest('player', 'unused-rel', 'Aro')).toEqual([]);
  });
});
