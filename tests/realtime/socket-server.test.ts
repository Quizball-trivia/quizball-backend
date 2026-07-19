import { describe, expect, it, vi } from 'vitest';

import '../setup.js';
import {
  buildRealtimeTimerHandlers,
  SOCKET_HEARTBEAT_CONFIG,
  type QuizballServer,
} from '../../src/realtime/socket-server.js';
import { runPossessionAiAnswer } from '../../src/realtime/possession-match-flow.js';

vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  finalizeHalftime: vi.fn(),
  resolvePossessionRound: vi.fn(),
  runPossessionAiAnswer: vi.fn(),
}));

describe('socket heartbeat config', () => {
  it('tolerates routine mobile network hiccups while keeping detection bounded', () => {
    expect(SOCKET_HEARTBEAT_CONFIG).toEqual({
      pingInterval: 2500,
      pingTimeout: 10000,
    });
    // Mobile radio wake-ups / wifi roaming / GC pauses routinely take 3-8s.
    // A timeout below that produced constant false disconnects in prod
    // (mass socket-drop bursts pausing 7+ matches at once, 2026-06-10).
    expect(SOCKET_HEARTBEAT_CONFIG.pingTimeout).toBeGreaterThanOrEqual(8000);
    // Worst-case disconnect detection must stay well inside the disconnect grace
    // window so the opponent overlay + grace flow remain meaningful.
    expect(
      SOCKET_HEARTBEAT_CONFIG.pingInterval + SOCKET_HEARTBEAT_CONFIG.pingTimeout
    ).toBeLessThanOrEqual(15000);
  });
});

describe('realtime timer handler wiring', () => {
  it('preserves an explicitly planned incorrect AI answer', async () => {
    const handler = buildRealtimeTimerHandlers().possession_ai_answer;
    const server = {} as QuizballServer;

    await handler?.(server, {
      kind: 'possession_ai_answer',
      matchId: 'match-1',
      qIndex: 11,
      plannedAnswerTimeMs: 12_103,
      plannedClueIndex: 1,
      plannedIsCorrect: false,
    });

    expect(runPossessionAiAnswer).toHaveBeenCalledWith(
      server,
      'match-1',
      11,
      12_103,
      1,
      false
    );
  });
});
