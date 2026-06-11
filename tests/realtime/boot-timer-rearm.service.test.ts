import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const listStaleActiveMatchesMock = vi.fn();
const ensurePossessionActiveTimersMock = vi.fn();
const ensurePartyQuizActiveTimerMock = vi.fn();
const resolveMatchVariantMock = vi.fn();
const redisExistsMock = vi.fn();

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    listStaleActiveMatches: (...a: unknown[]) => listStaleActiveMatchesMock(...a),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  resolveMatchVariant: (...a: unknown[]) => resolveMatchVariantMock(...a),
}));

vi.mock('../../src/realtime/possession-question-dispatch.js', () => ({
  ensurePossessionActiveTimers: (...a: unknown[]) => ensurePossessionActiveTimersMock(...a),
}));

vi.mock('../../src/realtime/party-quiz-match-flow.js', () => ({
  ensurePartyQuizActiveTimer: (...a: unknown[]) => ensurePartyQuizActiveTimerMock(...a),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({
    isOpen: true,
    exists: (...a: unknown[]) => redisExistsMock(...a),
  }),
}));

import { rearmActiveMatchTimersOnBoot } from '../../src/realtime/services/boot-timer-rearm.service.js';

const io = {} as QuizballServer;

function match(id: string, variant = 'ranked_sim') {
  return { id, mode: 'ranked', status: 'active', state_payload: { variant } };
}

beforeEach(() => {
  vi.clearAllMocks();
  redisExistsMock.mockResolvedValue(0);
  resolveMatchVariantMock.mockImplementation(
    (statePayload: { variant?: string }) => statePayload?.variant ?? 'ranked_sim'
  );
  ensurePossessionActiveTimersMock.mockResolvedValue(true);
  ensurePartyQuizActiveTimerMock.mockResolvedValue(true);
});

describe('boot timer re-arm', () => {
  it('re-arms possession timers for every active match after a restart', async () => {
    listStaleActiveMatchesMock.mockResolvedValue([match('m1'), match('m2')]);

    const summary = await rearmActiveMatchTimersOnBoot(io);

    expect(listStaleActiveMatchesMock).toHaveBeenCalledWith(0, expect.any(Number));
    expect(ensurePossessionActiveTimersMock).toHaveBeenCalledWith(io, 'm1');
    expect(ensurePossessionActiveTimersMock).toHaveBeenCalledWith(io, 'm2');
    expect(summary).toEqual({ scanned: 2, rearmed: 2, skippedPaused: 0, failed: 0 });
  });

  it('routes party-quiz matches to the party ensure path', async () => {
    listStaleActiveMatchesMock.mockResolvedValue([match('m1', 'friendly_party_quiz')]);

    await rearmActiveMatchTimersOnBoot(io);

    expect(ensurePartyQuizActiveTimerMock).toHaveBeenCalledWith(io, 'm1');
    expect(ensurePossessionActiveTimersMock).not.toHaveBeenCalled();
  });

  it('skips paused matches — the durable disconnect-grace timer owns them', async () => {
    listStaleActiveMatchesMock.mockResolvedValue([match('m1'), match('m2')]);
    redisExistsMock.mockImplementation(async (key: string) =>
      key === 'match:pause:m1' ? 1 : 0
    );

    const summary = await rearmActiveMatchTimersOnBoot(io);

    expect(ensurePossessionActiveTimersMock).toHaveBeenCalledTimes(1);
    expect(ensurePossessionActiveTimersMock).toHaveBeenCalledWith(io, 'm2');
    expect(summary.skippedPaused).toBe(1);
    expect(summary.rearmed).toBe(1);
  });

  it('keeps going when one match fails to re-arm', async () => {
    listStaleActiveMatchesMock.mockResolvedValue([match('m1'), match('m2')]);
    ensurePossessionActiveTimersMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(true);

    const summary = await rearmActiveMatchTimersOnBoot(io);

    expect(summary.failed).toBe(1);
    expect(summary.rearmed).toBe(1);
    expect(ensurePossessionActiveTimersMock).toHaveBeenCalledWith(io, 'm2');
  });

  it('no-ops cleanly when there are no active matches', async () => {
    listStaleActiveMatchesMock.mockResolvedValue([]);

    const summary = await rearmActiveMatchTimersOnBoot(io);

    expect(summary).toEqual({ scanned: 0, rearmed: 0, skippedPaused: 0, failed: 0 });
    expect(ensurePossessionActiveTimersMock).not.toHaveBeenCalled();
  });

  it('survives a failing scan query', async () => {
    listStaleActiveMatchesMock.mockRejectedValue(new Error('db down'));

    const summary = await rearmActiveMatchTimersOnBoot(io);

    expect(summary.scanned).toBe(0);
    expect(ensurePossessionActiveTimersMock).not.toHaveBeenCalled();
  });
});
