import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

// P1-1 (review 2026-10-06): the gameplay DB limiter gated EVERY match:answer, so ranked/possession answers (Redis-only on
// their critical path) queued behind Party Quiz / room / duel DB work and were rejected after 1.5 s under a burst.
const handleAnswer = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/realtime/services/match-realtime.service.js', () => ({ matchRealtimeService: { handleAnswer } }));
vi.mock('../../src/realtime/services/match-visibility.service.js', () => ({ handleVisibilitySignal: vi.fn() }));
vi.mock('../../src/realtime/possession-match-flow.js', () => ({ handlePossessionHalftimeUiReady: vi.fn() }));

const { registerMatchHandlers } = await import('../../src/realtime/handlers/match.handler.js');
const { gameplayDbTaskLimiter } = await import('../../src/realtime/socket-db-task-limiter.js');

describe('gameplay limiter scope: match answers', () => {
  it('a ranked answer is handled at once even while gameplay DB work fills every slot', async () => {
    // Party Quiz / room / duel DB work that holds all gameplay slots (never finishes during this test).
    const releases: Array<() => void> = [];
    for (let i = 0; i < 12; i += 1) void gameplayDbTaskLimiter.run(() => new Promise<void>((resolve) => { releases.push(resolve); })).catch(() => {});
    expect(gameplayDbTaskLimiter.stats().active).toBeGreaterThan(0);

    const handlers = new Map<string, (payload: unknown) => Promise<void>>();
    const socket = { data: { user: { id: 'u1' } }, on: (event: string, fn: (payload: unknown) => Promise<void>) => handlers.set(event, fn), emit: vi.fn() };
    registerMatchHandlers({} as never, socket as never);
    void handlers.get('match:answer')!({ matchId: '11111111-1111-4111-8111-111111111111', qIndex: 0, selectedIndex: 1, timeMs: 1200 });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handleAnswer).toHaveBeenCalledOnce();
    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    releases.forEach((release) => release());
  });
});
