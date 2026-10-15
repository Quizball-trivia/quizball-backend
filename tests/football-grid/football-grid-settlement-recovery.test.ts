import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  list: vi.fn(),
  observe: vi.fn(),
}));
vi.mock('../../src/db/index.js', () => ({ sql: mocks.sql }));
vi.mock('../../src/modules/football-grid/football-grid-bot-governor.service.js', () => ({
  footballGridBotGovernorService: {
    listUnobservedCompletedMatchIds: mocks.list,
    observeCompletedMatch: mocks.observe,
  },
}));

describe('Football Grid governor recovery scheduling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    mocks.sql.mockReset().mockResolvedValue([]);
    mocks.list.mockReset().mockResolvedValue([]);
    mocks.observe.mockReset().mockResolvedValue(null);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  async function start() {
    const { footballGridSettlementService } = await import('../../src/modules/football-grid/football-grid-settlement.service.js');
    const settle = vi.spyOn(footballGridSettlementService, 'settleMatch').mockResolvedValue(new Map());
    footballGridSettlementService.start();
    await vi.advanceTimersByTimeAsync(0);
    return settle;
  }

  it('polls rewards every five seconds while an empty governor backlog waits a minute', async () => {
    await start();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(mocks.sql).toHaveBeenCalledTimes(12);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('wakes immediately for pending settlements without delaying their rewards', async () => {
    const settle = await start();
    mocks.sql.mockResolvedValueOnce([{ match_id: 'new-match' }]);
    mocks.list.mockResolvedValueOnce(['new-match']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settle).toHaveBeenCalledWith('new-match');
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.observe).toHaveBeenCalledWith('new-match');
  });

  it('retries a scan failure on the next worker tick', async () => {
    mocks.list.mockRejectedValueOnce(new Error('temporary database failure'));
    await start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('keeps retrying an observation failure without entering the idle delay', async () => {
    mocks.list.mockResolvedValue(['retry-match']);
    mocks.observe.mockRejectedValue(new Error('temporary observation failure'));
    await start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.observe).toHaveBeenCalledTimes(2);
  });
});
