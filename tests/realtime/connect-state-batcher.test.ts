import { describe, expect, it, vi } from 'vitest';

import type { SessionStatePayload } from '../../src/realtime/socket.types.js';
import { ConnectStateBatcher } from '../../src/realtime/connect-state-batcher.js';

function idle(userId: string): SessionStatePayload {
  return {
    state: 'IDLE',
    activeMatchId: null,
    waitingLobbyId: null,
    queueSearchId: null,
    openLobbyIds: [],
    resolvedAt: userId,
  };
}

describe('ConnectStateBatcher', () => {
  it('coalesces simultaneous users into one resolver call', async () => {
    vi.useFakeTimers();
    const resolver = vi.fn(async (userIds: string[]) => (
      new Map(userIds.map((userId) => [userId, idle(userId)]))
    ));
    const batcher = new ConnectStateBatcher(resolver, 25, 100);

    const one = batcher.resolve('u1');
    const two = batcher.resolve('u2');
    await vi.advanceTimersByTimeAsync(25);

    await expect(Promise.all([one, two])).resolves.toEqual([idle('u1'), idle('u2')]);
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith(['u1', 'u2']);
    vi.useRealTimers();
  });

  it('fans one user result out to duplicate socket requests', async () => {
    vi.useFakeTimers();
    const resolver = vi.fn(async (userIds: string[]) => (
      new Map(userIds.map((userId) => [userId, idle(userId)]))
    ));
    const batcher = new ConnectStateBatcher(resolver, 10, 100);

    const first = batcher.resolve('u1');
    const second = batcher.resolve('u1');
    await vi.advanceTimersByTimeAsync(10);

    await expect(Promise.all([first, second])).resolves.toEqual([idle('u1'), idle('u1')]);
    expect(resolver).toHaveBeenCalledWith(['u1']);
    vi.useRealTimers();
  });

  it('rejects every waiter when the batched resolver fails', async () => {
    vi.useFakeTimers();
    const resolver = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    const batcher = new ConnectStateBatcher(resolver, 10, 100);

    const requests = [batcher.resolve('u1'), batcher.resolve('u2')];
    const assertions = requests.map((request) => (
      expect(request).rejects.toThrow('database unavailable')
    ));
    await vi.advanceTimersByTimeAsync(10);

    await Promise.all(assertions);
    vi.useRealTimers();
  });
});
