import { describe, expect, it, vi } from 'vitest';

import '../setup.js';
import {
  __socketServerInternals,
  buildRealtimeTimerHandlers,
  SOCKET_COMPRESSION_CONFIG,
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
      pingInterval: 4000,
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
    // Every socket ping/pongs on this interval for its whole lifetime, so it
    // sets a per-socket egress floor that scales with concurrency rather than
    // with play. This is a cost floor, not a safety property — keep it well
    // above the old 2500ms without pinning a value that blocks future tuning.
    expect(SOCKET_HEARTBEAT_CONFIG.pingInterval).toBeGreaterThanOrEqual(4000);
  });
});

describe('socket compression config', () => {
  it('keeps zlib context takeover enabled', () => {
    // Context takeover is the whole win: measured 95-96% smaller frames with
    // it vs 34-44% without. ws disables it when either no_context_takeover flag
    // is negotiated, so guard against a well-meaning "memory fix" turning it on.
    expect('serverNoContextTakeover' in SOCKET_COMPRESSION_CONFIG).toBe(false);
    expect('clientNoContextTakeover' in SOCKET_COMPRESSION_CONFIG).toBe(false);
  });

  it('bounds per-connection zlib memory', () => {
    // ws allocates a zlib context per connection. At the default 15-bit window
    // that is ~318 KB/socket, which does not fit thousands of concurrent
    // sockets on this container (peak RSS 1.25 GB).
    expect(SOCKET_COMPRESSION_CONFIG.zlibDeflateOptions.windowBits).toBeLessThanOrEqual(13);
    expect(SOCKET_COMPRESSION_CONFIG.zlibDeflateOptions.memLevel).toBeLessThanOrEqual(6);
    // ws overrides zlibDeflateOptions.windowBits with the NEGOTIATED
    // <endpoint>_max_window_bits, defaulting to 15 when unset — without these
    // the bound above silently does not apply (793 KB/socket vs 254 KB).
    expect(SOCKET_COMPRESSION_CONFIG.serverMaxWindowBits).toBeLessThanOrEqual(13);
    expect(SOCKET_COMPRESSION_CONFIG.clientMaxWindowBits).toBeLessThanOrEqual(13);
  });
});

describe('socket disconnect DB task routing', () => {
  it('avoids the unrelated fallback for a socket with a known binding', () => {
    expect(__socketServerInternals.selectDisconnectDbTasks({ lobbyId: 'lobby-1' }))
      .toEqual(['lobby_disconnect']);
    expect(__socketServerInternals.selectDisconnectDbTasks({ matchId: 'match-1' }))
      .toEqual(['match_disconnect']);
  });

  it('retains both recovery lookups for unbound or inconsistent sockets', () => {
    expect(__socketServerInternals.selectDisconnectDbTasks({}))
      .toEqual(['lobby_disconnect', 'match_disconnect']);
    expect(__socketServerInternals.selectDisconnectDbTasks({
      lobbyId: 'lobby-1',
      matchId: 'match-1',
    })).toEqual(['lobby_disconnect', 'match_disconnect']);
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
      false,
      // The promoted handler forwards the optional planned-answer context
      // (unset in this fixture) — the implementation ignores absent values.
      undefined,
      undefined,
      undefined
    );
  });
});
