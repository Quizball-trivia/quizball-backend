import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoAnswer } from '../../game-regression/staging/bot-behaviors.mjs';
import type { StagingClient } from '../../game-regression/staging/staging-client.mjs';

function makeClient(): {
  client: StagingClient;
  handlers: Map<string, Array<(payload: never) => void>>;
  emit: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, Array<(payload: never) => void>>();
  const emit = vi.fn();
  const socket = {
    on: vi.fn((event: string, handler: (payload: never) => void) => {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
      return socket;
    }),
    emit,
  };
  return {
    client: {
      socket,
      latest: vi.fn(),
    } as unknown as StagingClient,
    handlers,
    emit,
  };
}

function dispatch(
  handlers: Map<string, Array<(payload: never) => void>>,
  event: string,
  payload: unknown,
): void {
  for (const handler of handlers.get(event) ?? []) handler(payload as never);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('staging auto-answer behavior', () => {
  it('cancels a scheduled answer after final results arrive', async () => {
    vi.useFakeTimers();
    const { client, handlers, emit } = makeClient();
    autoAnswer(client, {
      answerPlan: () => ({ mode: 'correct', timeMs: 500, delayMs: 1_000 }),
    });

    dispatch(handlers, 'match:question', {
      matchId: 'match-finished',
      qIndex: 9,
      correctIndex: 0,
      question: { kind: 'multipleChoice' },
    });
    dispatch(handlers, 'match:final_results', { matchId: 'match-finished' });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(emit).not.toHaveBeenCalledWith('match:answer', expect.anything());
  });
});
