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

  it('serializes max-size chunks during an instantaneous reconnect storm', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const resolver = vi.fn(async (userIds: string[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return new Map(userIds.map((userId) => [userId, idle(userId)]));
    });
    const batcher = new ConnectStateBatcher(resolver, 10_000, 2);

    const results = ['u1', 'u2', 'u3', 'u4'].map((userId) => batcher.resolve(userId));
    const settled = Promise.all(results);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    expect(resolver.mock.calls[0]?.[0]).toEqual(['u1', 'u2']);

    releases.shift()?.();
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2));
    expect(resolver.mock.calls[1]?.[0]).toEqual(['u3', 'u4']);
    expect(maxActive).toBe(1);

    releases.shift()?.();
    await expect(settled).resolves.toHaveLength(4);
  });
});
