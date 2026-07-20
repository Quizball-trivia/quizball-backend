import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer } from '../../src/realtime/socket-server.js';
import {
  acknowledgeLocalMatchUiReady,
  acknowledgeMatchUiReady,
  openMatchUiReadyGate,
  resetMatchUiReadyGates,
} from '../../src/realtime/match-ui-ready-gate.js';

function ioMock() {
  const emit = vi.fn();
  return {
    io: {
      to: vi.fn(() => ({ emit })),
      serverSideEmit: vi.fn(),
    } as unknown as QuizballServer,
    emit,
  };
}

describe('match UI-ready gate replica forwarding', () => {
  afterEach(() => resetMatchUiReadyGates());

  it('forwards an acknowledgement when the gate is owned by another replica', () => {
    const { io } = ioMock();

    expect(acknowledgeMatchUiReady(io, 'u1', 'remote-match', 'kickoff')).toBe(true);
    expect(io.serverSideEmit).toHaveBeenCalledWith(
      'match:ui_ready_ack',
      'u1',
      'remote-match',
      'kickoff',
    );
  });

  it('lets the owning replica consume forwarded acknowledgements exactly once', () => {
    const { io } = ioMock();
    const dispatch = vi.fn();
    openMatchUiReadyGate({
      io,
      matchId: 'owned-match',
      phase: 'kickoff',
      waitingUserIds: ['u1', 'u2'],
      ceilingMs: 10_000,
      emitInitial: false,
      dispatch,
    });

    expect(acknowledgeLocalMatchUiReady(io, 'u1', 'owned-match', 'kickoff')).toBe(true);
    expect(acknowledgeLocalMatchUiReady(io, 'u2', 'owned-match', 'kickoff')).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ reason: 'all_ready', missingUserIds: [] });
    expect(io.serverSideEmit).not.toHaveBeenCalled();
  });
});
