import { describe, expect, it, vi } from 'vitest';
import { category, coverage, directory } from '../darts501/fixture.js';

const state = vi.hoisted(() => ({ ready: false }));
vi.mock('../../src/db/index.js', () => ({ sql: vi.fn(async () => []) }));
vi.mock('../../src/modules/tenable/tenable.directories.js', () => ({
  // A load is running (held) but has not finished: under the lock it must not be awaited.
  tenableDirectories: { loaded: () => true, ready: () => (state.ready ? directory : undefined), get: () => new Promise(() => undefined) },
}));
vi.mock('../../src/modules/darts501/darts501.coverage.js', () => ({
  darts501Coverage: { loaded: () => true, ready: () => coverage, get: async () => coverage },
}));

const { darts501RoomEngine } = await import('../../src/modules/room/games/darts501/darts501.room.js');
const pack = { pack: { legs: [category('a', 'easy'), category('b', 'medium'), category('c', 'hard')], seed: 1 }, boards: null };
const tx = {} as never;

describe('hydrating a darts501 match under the match lock', () => {
  it('refuses at once (retryable) while a directory load is still running', async () => {
    state.ready = false;
    await expect(darts501RoomEngine.hydrate!(pack, null, tx)).rejects.toThrow('room_content_unavailable');
  });
  it('uses the finished loads without waiting', async () => {
    state.ready = true;
    const hydrated = await darts501RoomEngine.hydrate!(pack, null, tx);
    expect(hydrated.boards).toHaveLength(3);
  });
});
