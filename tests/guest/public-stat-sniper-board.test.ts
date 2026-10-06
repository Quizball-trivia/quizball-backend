import { beforeEach, describe, expect, it, vi } from 'vitest';

const getStatSniperLeaderboard = vi.fn();
vi.mock('../../src/modules/daily-challenges/daily-challenges.service.js', () => ({
  dailyChallengesService: { getStatSniperLeaderboard: (...args: unknown[]) => getStatSniperLeaderboard(...args) },
}));

const board = (day: string) => ({
  challengeDay: day,
  entries: [{ userId: 'u-secret', rank: 1, username: 'KAKA007', avatarCustomization: { base: 'a' }, country: 'GE', score: 91 }],
  me: { rank: 9, total: 20 },
});

describe('public Stat Sniper board', () => {
  beforeEach(() => { vi.resetModules(); getStatSniperLeaderboard.mockReset(); });

  it('shows rank, name, score, flag and avatar, but no user id and no personal row', async () => {
    getStatSniperLeaderboard.mockResolvedValue(board('2026-10-06'));
    const { publicStatSniperBoard } = await import('../../src/modules/guest/guest.controller.js');
    const result = await publicStatSniperBoard(1_000);
    expect(getStatSniperLeaderboard).toHaveBeenCalledWith(null);
    expect(result).toEqual({ challengeDay: '2026-10-06', entries: [{ rank: 1, alias: 'KAKA007', score: 91, country: 'GE', avatarCustomization: { base: 'a' } }], me: null });
    expect(JSON.stringify(result)).not.toContain('u-secret');
  });

  it('serves one query per 30 s, then refreshes', async () => {
    getStatSniperLeaderboard.mockResolvedValueOnce(board('2026-10-06')).mockResolvedValueOnce(board('2026-10-07'));
    const { publicStatSniperBoard } = await import('../../src/modules/guest/guest.controller.js');
    await publicStatSniperBoard(1_000);
    await publicStatSniperBoard(20_000);
    expect(getStatSniperLeaderboard).toHaveBeenCalledTimes(1);
    expect((await publicStatSniperBoard(31_001)).challengeDay).toBe('2026-10-07');
    expect(getStatSniperLeaderboard).toHaveBeenCalledTimes(2);
  });

  it('retries a failed load after a short pause, not on every request', async () => {
    getStatSniperLeaderboard.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(board('2026-10-06'));
    const { publicStatSniperBoard } = await import('../../src/modules/guest/guest.controller.js');
    await expect(publicStatSniperBoard(1_000)).rejects.toThrow('timeout');
    for (let t = 1_010; t < 6_000; t += 10) await expect(publicStatSniperBoard(t)).rejects.toThrow('timeout');
    expect(getStatSniperLeaderboard).toHaveBeenCalledTimes(1);
    expect((await publicStatSniperBoard(6_001)).entries).toHaveLength(1);
    expect(getStatSniperLeaderboard).toHaveBeenCalledTimes(2);
  });

  it('never serves the previous day after UTC midnight, even inside the cache window', async () => {
    getStatSniperLeaderboard.mockResolvedValueOnce(board('2026-10-06')).mockResolvedValueOnce(board('2026-10-07'));
    const { publicStatSniperBoard } = await import('../../src/modules/guest/guest.controller.js');
    const beforeMidnight = Date.parse('2026-10-06T23:59:50Z');
    expect((await publicStatSniperBoard(beforeMidnight)).challengeDay).toBe('2026-10-06');
    expect((await publicStatSniperBoard(beforeMidnight + 11_000)).challengeDay).toBe('2026-10-07');
    expect(getStatSniperLeaderboard).toHaveBeenCalledTimes(2);
  });
});
