import { describe, expect, it, vi } from 'vitest';
import { directory } from './fixture.js';

vi.mock('../../src/db/index.js', () => ({ sql: vi.fn(async () => []) }));
vi.mock('../../src/modules/tenable/tenable.directories.js', () => ({ tenableDirectories: { loaded: () => false, get: async () => directory } }));
vi.mock('../../src/modules/tenable-daily/tenable-daily.service.js', () => ({
  tenableDailyContent: { get: async () => new Map([['2026-11-01', { list: { kind: 'player', release: 'rel' } }]]) },
  tenableRoomPairs: async () => [],
}));
vi.mock('../../src/modules/darts501-daily/darts501-daily.service.js', () => ({
  darts501DailyContent: { get: async () => { throw new Error('darts501_days unavailable'); } },
  darts501RoomPairs: async () => { throw new Error('room_pool unavailable'); },
}));

const { suggest } = await import('../../src/modules/tenable/tenable.suggest.js');

describe('suggestions when Football Darts 501 cannot be read', () => {
  it("Tenable's own releases are still served", async () => {
    expect((await suggest('player', 'rel', 'Aro')).map((s) => s.eid)).toContain('p0');
  });
});
