import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const listPendingAiFriendRequestsMock = vi.fn();
const acceptRequestMock = vi.fn();

vi.mock('../../src/modules/friends/friends.repo.js', () => ({
  friendsRepo: {
    listPendingAiFriendRequests: (...args: unknown[]) => listPendingAiFriendRequestsMock(...args),
    acceptRequest: (...args: unknown[]) => acceptRequestMock(...args),
  },
}));

import {
  getAiFriendResponderDecision,
  runAiFriendResponderTick,
  type AiFriendResponderDecision,
} from '../../src/modules/friends/ai-friend-responder.service.js';

function findRequestId(predicate: (decision: AiFriendResponderDecision) => boolean): string {
  for (let index = 0; index < 100_000; index++) {
    const requestId = `synthetic-request-${index}`;
    if (predicate(getAiFriendResponderDecision(requestId))) {
      return requestId;
    }
  }
  throw new Error('Unable to find matching synthetic request id');
}

function pendingAiRequest(id: string, receiverUserId: string, createdAt: Date) {
  return {
    id,
    receiver_user_id: receiverUserId,
    created_at: createdAt.toISOString(),
  };
}

describe('aiFriendResponder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPendingAiFriendRequestsMock.mockResolvedValue([]);
    acceptRequestMock.mockResolvedValue('accepted');
  });

  it('derives the same decision for the same request id', () => {
    const first = getAiFriendResponderDecision('request-id-1');
    const second = getAiFriendResponderDecision('request-id-1');

    expect(second).toEqual(first);
  });

  it('accepts roughly 30% of synthetic request ids', () => {
    const total = 10_000;
    let accepted = 0;

    for (let index = 0; index < total; index++) {
      if (getAiFriendResponderDecision(`synthetic-request-${index}`).shouldAccept) {
        accepted++;
      }
    }

    const ratio = accepted / total;
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(0.35);
  });

  it('does not accept before the deterministic delay elapses', async () => {
    const requestId = findRequestId((decision) => decision.shouldAccept);
    const decision = getAiFriendResponderDecision(requestId);
    const now = new Date('2026-07-05T12:00:00.000Z');
    const createdAt = new Date(now.getTime() - decision.delayMs + 1);

    listPendingAiFriendRequestsMock.mockResolvedValue([
      pendingAiRequest(requestId, 'ai-user-id', createdAt),
    ]);

    const result = await runAiFriendResponderTick({ now: () => now });

    expect(result.deferred).toBe(1);
    expect(acceptRequestMock).not.toHaveBeenCalled();
  });

  it('accepts after the deterministic delay through the repo accept path', async () => {
    const requestId = findRequestId((decision) => decision.shouldAccept);
    const decision = getAiFriendResponderDecision(requestId);
    const now = new Date('2026-07-05T12:00:00.000Z');
    const createdAt = new Date(now.getTime() - decision.delayMs);

    listPendingAiFriendRequestsMock.mockResolvedValue([
      pendingAiRequest(requestId, 'ai-user-id', createdAt),
    ]);
    acceptRequestMock.mockResolvedValue('accepted');

    const result = await runAiFriendResponderTick({ now: () => now });

    expect(acceptRequestMock).toHaveBeenCalledWith(requestId, 'ai-user-id');
    expect(result.accepted).toBe(1);
  });

  it('never accepts ignored request ids even after a long age', async () => {
    const requestId = findRequestId((decision) => !decision.shouldAccept);
    const now = new Date('2026-07-05T12:00:00.000Z');
    const createdAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    listPendingAiFriendRequestsMock.mockResolvedValue([
      pendingAiRequest(requestId, 'ai-user-id', createdAt),
    ]);

    const result = await runAiFriendResponderTick({ now: () => now });

    expect(result.ignored).toBe(1);
    expect(acceptRequestMock).not.toHaveBeenCalled();
  });

  it('treats already-handled accept results as idempotent', async () => {
    const requestId = findRequestId((decision) => decision.shouldAccept);
    const decision = getAiFriendResponderDecision(requestId);
    const now = new Date('2026-07-05T12:00:00.000Z');
    const createdAt = new Date(now.getTime() - decision.delayMs);

    listPendingAiFriendRequestsMock.mockResolvedValue([
      pendingAiRequest(requestId, 'ai-user-id', createdAt),
    ]);
    acceptRequestMock.mockResolvedValue('not_found');

    const result = await runAiFriendResponderTick({ now: () => now });

    expect(acceptRequestMock).toHaveBeenCalledWith(requestId, 'ai-user-id');
    expect(result.accepted).toBe(0);
    expect(result.alreadyHandled).toBe(1);
  });
});
