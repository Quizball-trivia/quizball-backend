import { describe, expect, it } from 'vitest';
import { SocketRuntimeTracker } from '../../src/realtime/socket-runtime-stats.js';

describe('SocketRuntimeTracker', () => {
  it('tracks active, peak, and cumulative accepted connections', () => {
    const tracker = new SocketRuntimeTracker();

    tracker.connected();
    tracker.connected();
    tracker.disconnected();
    tracker.connected();

    expect(tracker.stats()).toEqual({ active: 2, peak: 2, accepted: 3 });
  });

  it('never reports a negative active count', () => {
    const tracker = new SocketRuntimeTracker();

    tracker.disconnected();

    expect(tracker.stats()).toEqual({ active: 0, peak: 0, accepted: 0 });
  });
});
