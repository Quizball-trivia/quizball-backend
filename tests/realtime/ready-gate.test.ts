import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadyGateRegistry } from '../../src/realtime/ready-gate.js';

describe('createReadyGateRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches once all waiting users acknowledge the matching token', () => {
    const registry = createReadyGateRegistry<number>();
    const dispatch = vi.fn();

    registry.open({
      scopeId: 'match-1',
      token: 4,
      waitingUserIds: ['user-a', 'user-b'],
      ceilingMs: 5000,
      dispatch,
    });

    expect(registry.acknowledge('user-a', 'match-1', 4)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();

    expect(registry.acknowledge('user-b', 'match-1', 4)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('dispatches on ceiling timeout with the remaining missing users', () => {
    const registry = createReadyGateRegistry<number>();
    const dispatch = vi.fn();
    const onTimeout = vi.fn();

    registry.open({
      scopeId: 'match-2',
      token: 7,
      waitingUserIds: ['user-a', 'user-b'],
      ceilingMs: 5000,
      dispatch,
      onTimeout,
    });

    registry.acknowledge('user-a', 'match-2', 7);
    vi.advanceTimersByTime(5000);

    expect(onTimeout).toHaveBeenCalledWith(['user-b']);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
