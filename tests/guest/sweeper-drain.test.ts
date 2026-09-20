import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ trivia: vi.fn(), squad: vi.fn(), idle: vi.fn() }));
vi.mock('../../src/modules/trivia-mines/trivia-mines.service.js', () => ({ triviaMinesService: { sweepStaleRounds: mocks.trivia } }));
vi.mock('../../src/modules/squad-spin/squad-spin.service.js', () => ({ squadSpinService: { sweepExpiredRounds: mocks.squad } }));
vi.mock('../../src/modules/guest/guest.repo.js', () => ({ guestRepo: { listIdleIds: mocks.idle } }));
vi.mock('../../src/modules/guest/guest.service.js', () => ({ GUEST_PURGE_DAYS: 45 }));
vi.mock('../../src/modules/users/user-cache.js', () => ({ invalidateUser: vi.fn() }));
vi.mock('../../src/realtime/services/auth-realtime.service.js', () => ({ disconnectUserSockets: vi.fn() }));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { startTriviaMinesSweeper, stopTriviaMinesSweeper } from '../../src/modules/trivia-mines/trivia-mines.sweeper.js';
import { startSquadSpinSweeper, stopSquadSpinSweeper } from '../../src/modules/squad-spin/squad-spin.sweeper.js';
import { startGuestSweeper, stopGuestSweeper } from '../../src/modules/guest/guest.sweeper.js';
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('release shutdown drains active work', () => {
  for (const [name, run, start, stop] of [
    ['Trivia Mines', mocks.trivia, startTriviaMinesSweeper, stopTriviaMinesSweeper],
    ['Squad Spin', mocks.squad, startSquadSpinSweeper, stopSquadSpinSweeper],
  ] as const) {
    it(`${name} waits for an active settlement and starts no further sweep`, async () => {
      vi.useFakeTimers();
      let finish!: (value: { settled: number }) => void;
      run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      start();
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(run).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finish({ settled: 1 });
      await stopping;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  }
  it('cancels a guest startup sweep when shutdown happens before its first run', async () => {
    vi.useFakeTimers();
    startGuestSweeper();
    await stopGuestSweeper();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(mocks.idle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
