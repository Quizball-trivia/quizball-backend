import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ achievements: vi.fn(), xp: vi.fn(), objectives: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../src/core/logger.js', () => ({ logger: { warn: mocks.warn, error: mocks.error } }));
vi.mock('../../src/modules/achievements/index.js', () => ({ achievementsService: { evaluateForMatch: mocks.achievements } }));
vi.mock('../../src/modules/progression/progression.service.js', () => ({ progressionService: { awardCompletedMatchXp: mocks.xp } }));
vi.mock('../../src/modules/objectives/index.js', () => ({ objectivesService: { evaluateForMatch: mocks.objectives } }));
vi.mock('../../src/core/config.js', () => ({ config: { OBJECTIVES_ENABLED: true } }));
// The job bookkeeping (party_reward_jobs) is covered against a real database in party-reward-reconciler.integration;
// here every claim succeeds so the tests isolate scheduling.
vi.mock('../../src/db/index.js', () => {
  const sql = vi.fn();
  return { sql, withStatementTimeout: (run: (tx: unknown) => unknown) => run(sql) };
});
const claimAlwaysSucceeds = async (strings: TemplateStringsArray) => {
  const text = strings.join('?');
  if (text.includes('gen_random_uuid()')) return [{ attempts: 1, token: 'token', occurred_at: new Date() }];
  return text.includes('RETURNING 1') ? [{}] : [];
};
const { runPartyCompletionWork, partyCompletionDbTaskLimiter } = await import('../../src/realtime/party-completion-work.js');
const { sql } = await import('../../src/db/index.js');

describe('Party completion database budget', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sql).mockImplementation(claimAlwaysSucceeds as never);
    mocks.achievements.mockResolvedValue({});
    mocks.xp.mockResolvedValue(undefined);
    mocks.objectives.mockResolvedValue(undefined);
  });

  it('runs at most the completion limit of matches at once, players one by one per match, off the answer burst', async () => {
    const releases = new Map<string, () => void>();
    const order: string[] = [];
    mocks.achievements.mockImplementation(async (matchId, ids) => {
      order.push(`${matchId}:${ids.join(',')}`);
      if (ids[0] === 'u1' || ids[0] === 'u3') await new Promise<void>((resolve) => { releases.set(matchId, resolve); });
    });
    const refresh = (id: string) => vi.fn(async () => { order.push(`${id}:refresh`); });
    const a = runPartyCompletionWork('A', ['u1', 'u2', 'u1'], refresh('A'));
    const b = runPartyCompletionWork('B', ['u3'], refresh('B'));
    const c = runPartyCompletionWork('C', ['u4'], refresh('C'));
    await vi.waitFor(() => expect(releases.size).toBe(2));
    const { limit } = partyCompletionDbTaskLimiter.stats();
    expect(partyCompletionDbTaskLimiter.stats()).toMatchObject({ active: limit, queued: 1 });
    expect(mocks.xp).not.toHaveBeenCalled();
    releases.get('A')!();
    releases.get('B')!();
    await Promise.all([a, b, c]);
    const forMatch = (id: string) => order.filter((step) => step.startsWith(`${id}:`));
    expect(forMatch('A')).toEqual(['A:u1', 'A:u2', 'A:refresh']);
    expect(forMatch('B')).toEqual(['B:u3', 'B:refresh']);
    expect(forMatch('C')).toEqual(['C:u4', 'C:refresh']);
    expect(mocks.achievements.mock.calls.every(([, ids]) => ids.length === 1)).toBe(true);
    expect(mocks.xp.mock.calls.map(([id]) => id).sort()).toEqual(['A', 'B', 'C']);
    expect(partyCompletionDbTaskLimiter.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('a failed step skips no other player, objectives, XP or result refresh, and the job is left to retry', async () => {
    mocks.achievements.mockRejectedValueOnce(new Error('achievement unavailable'));
    mocks.xp.mockRejectedValueOnce(new Error('xp unavailable'));
    const refresh = vi.fn(async () => {});
    await runPartyCompletionWork('A', ['u1', 'u2'], refresh);
    expect(mocks.achievements).toHaveBeenCalledTimes(2);
    expect(mocks.objectives).toHaveBeenCalledWith('A', expect.any(Date));
    expect(mocks.xp).toHaveBeenCalledWith('A', expect.any(Date));
    expect(refresh).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 'A', failures: [expect.stringContaining('achievements u1'), expect.stringContaining('xp')] }),
      expect.stringContaining('will retry'),
    );
  });

  it('writes match XP after every other reward step, so the reconciler never reads "XP present" for a half-rewarded match', async () => {
    const steps: string[] = [];
    mocks.achievements.mockImplementation(async () => { steps.push('achievements'); });
    mocks.objectives.mockImplementation(async () => { steps.push('objectives'); });
    mocks.xp.mockImplementation(async () => { steps.push('xp'); });
    await runPartyCompletionWork('A', ['u1', 'u2'], async () => { steps.push('refresh'); });
    expect(steps).toEqual(['achievements', 'achievements', 'objectives', 'xp', 'refresh']);
  });

  it('releases the budget after a failed result refresh', async () => {
    await expect(runPartyCompletionWork('A', ['u1'], async () => { throw new Error('refresh failed'); })).rejects.toThrow('refresh failed');
    const refresh = vi.fn(async () => {});
    await runPartyCompletionWork('B', ['u2'], refresh);
    expect(refresh).toHaveBeenCalledOnce();
    expect(partyCompletionDbTaskLimiter.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('P2: rewards deferred by an overloaded queue are logged as an error naming the match (the job stays pending)', async () => {
    vi.useFakeTimers();
    try {
      const releases: Array<() => void> = [];
      mocks.achievements.mockImplementation(async (matchId) => { if (String(matchId).startsWith('SLOW')) await new Promise<void>((resolve) => { releases.push(resolve); }); });
      const { limit } = partyCompletionDbTaskLimiter.stats();
      const slow = Array.from({ length: limit }, (_, i) => runPartyCompletionWork(`SLOW${i}`, ['u1'], async () => {}));
      const deferred = runPartyCompletionWork('LATE', ['u2', 'u3'], async () => {});
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      await deferred.catch(() => {});
      expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ matchId: 'LATE', userIds: ['u2', 'u3'] }), expect.stringContaining('deferred'));
      releases.forEach((release) => release());
      await Promise.all(slow);
    } finally { vi.useRealTimers(); }
  });

  it('P2 (round 2): a backlog of 50 completed matches (3 s of reward work each) rewards all 50, none expire', async () => {
    vi.useFakeTimers();
    try {
      const rewarded = new Set<string>();
      mocks.achievements.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 3_000)));
      mocks.xp.mockImplementation(async (matchId: string) => { rewarded.add(matchId); });
      const jobs = Array.from({ length: 50 }, (_, i) => runPartyCompletionWork(`B${i}`, ['u1'], async () => {}).catch(() => {}));
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await Promise.all(jobs);
      expect(rewarded.size).toBe(50);
    } finally { vi.useRealTimers(); }
  });
});
