import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import '../setup.js';
import {
  __socketServerInternals,
  buildRealtimeTimerHandlers,
  type QuizballServer,
  SOCKET_COMPRESSION_CONFIG,
  SOCKET_HEARTBEAT_CONFIG,
} from '../../src/realtime/socket-server.js';
import { runPossessionAiAnswer } from '../../src/realtime/possession-match-flow.js';
import { buildFinalResultsPayload, emitFinalResultsToMatchParticipants } from '../../src/realtime/services/match-final-results.service.js';

vi.mock('../../src/realtime/services/match-final-results.service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/realtime/services/match-final-results.service.js')>(),
  buildFinalResultsPayload: vi.fn(),
  emitFinalResultsToMatchParticipants: vi.fn(),
}));

describe('terminal final-results timer', () => {
  const payload = { kind: 'match_final_results' as const, matchId: 'cancelled-match', resultVersion: 123 };

  it('delivers results independently of the terminal match question timer', async () => {
    const results = { matchId: payload.matchId, cancelledNoContest: true };
    vi.mocked(buildFinalResultsPayload).mockResolvedValueOnce(results as never);
    await buildRealtimeTimerHandlers().match_final_results!({} as QuizballServer, payload);
    expect(buildFinalResultsPayload).toHaveBeenCalledWith(payload.matchId, 123);
    expect(emitFinalResultsToMatchParticipants).toHaveBeenCalledWith({}, payload.matchId, results);
  });

  it('rejects unavailable results so the scheduler retries', async () => {
    vi.mocked(buildFinalResultsPayload).mockResolvedValueOnce(null);
    await expect(buildRealtimeTimerHandlers().match_final_results!({} as QuizballServer, payload))
      .rejects.toThrow('Final results unavailable');
  });

  it('propagates delivery errors so the scheduler retries', async () => {
    vi.mocked(buildFinalResultsPayload).mockResolvedValueOnce({ matchId: payload.matchId } as never);
    vi.mocked(emitFinalResultsToMatchParticipants).mockRejectedValueOnce(new Error('temporary delivery failure'));
    await expect(buildRealtimeTimerHandlers().match_final_results!({} as QuizballServer, payload))
      .rejects.toThrow('temporary delivery failure');
  });
});

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
  });

  it('keeps permessage-deflate DISABLED on the live server (iOS incident 2026-09-04)', () => {
    // Fixed 13-bit window negotiation broke every WebKit client: Safari/iOS
    // does not offer client_max_window_bits, and RFC 7692 obliges a client to
    // fail the connection when the server responds with a parameter it never
    // offered (~124 iOS users, ~9K "websocket error" failures in 12h).
    // SOCKET_COMPRESSION_CONFIG stays exported for a future WebKit-safe
    // re-attempt, but it must NOT be wired to the server until proven on
    // staging against a real iOS client.
    const src = readFileSync(
      resolve(__dirname, '../../src/realtime/socket-server.ts'), 'utf8');
    expect(src).toContain('perMessageDeflate: false');
    expect(src).not.toContain('perMessageDeflate: SOCKET_COMPRESSION_CONFIG');
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
