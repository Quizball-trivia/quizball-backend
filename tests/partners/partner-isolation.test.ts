import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

import '../setup.js';

const repo = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock('../../src/modules/users/users.repo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/modules/users/users.repo.js')>()),
  usersRepo: { getById: repo.getById },
}));
const friends = vi.hoisted(() => ({ createFriendRequest: vi.fn(), friendshipExists: vi.fn(), getPendingRequestBetween: vi.fn() }));
vi.mock('../../src/modules/friends/friends.repo.js', () => ({ friendsRepo: friends }));
vi.mock('../../src/modules/notifications/notifications.service.js', () => ({ notificationsService: { notify: vi.fn() } }));
const stats = vi.hoisted(() => ({ getHeadToHead: vi.fn(async () => ({ ok: true })), getRecentMatchesForUser: vi.fn(async () => []) }));
vi.mock('../../src/modules/stats/stats.service.js', () => ({ statsService: stats }));
const sessions = vi.hoisted(() => ({ forget: vi.fn() }));
vi.mock('../../src/modules/partners/partner-sessions.service.js', () => ({ forgetExpiredInitResponses: sessions.forget }));

import { isPartnerOrStaff } from '../../src/modules/users/account-kind.js';
import { emitPartnerPlayerBlocked, onPartnerPlayerBlocked } from '../../src/modules/partners/partner-events.js';
import { startPartnerJanitor, stopPartnerJanitor } from '../../src/modules/partners/partner-janitor.js';

const MEMBER = { id: 'member', is_ai: false, is_guest: false, partner_slug: null, role: 'user' };
const PARTNER = { id: 'partner', is_ai: false, is_guest: false, partner_slug: 'freecroco', role: 'user' };
const STAFF = { id: 'staff', is_ai: false, is_guest: false, partner_slug: null, role: 'partner_staff' };
const byId = (id: string) => [MEMBER, PARTNER, STAFF].find((u) => u.id === id) ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  repo.getById.mockImplementation(async (id: string) => byId(id));
});

describe('account kind', () => {
  it('partner players and partner staff are not members', () => {
    expect(isPartnerOrStaff(MEMBER)).toBe(false);
    expect(isPartnerOrStaff(PARTNER)).toBe(true);
    expect(isPartnerOrStaff(STAFF)).toBe(true);
    expect(isPartnerOrStaff({})).toBe(false);
  });
});

describe('friend requests', () => {
  it('refuse partner and staff targets and senders like a missing user', async () => {
    const { friendsService } = await import('../../src/modules/friends/friends.service.js');
    await expect(friendsService.createRequest('member', 'partner')).rejects.toMatchObject({ statusCode: 404 });
    await expect(friendsService.createRequest('member', 'staff')).rejects.toMatchObject({ statusCode: 404 });
    await expect(friendsService.createRequest('staff', 'member')).rejects.toMatchObject({ statusCode: 404 });
    expect(friends.createFriendRequest).not.toHaveBeenCalled();
  });
});

describe('public profiles', () => {
  it('a partner player or staff account is not publicly visible', async () => {
    const { usersService } = await import('../../src/modules/users/users.service.js');
    await expect(usersService.assertPublicUserVisible('partner')).rejects.toMatchObject({ statusCode: 404 });
    await expect(usersService.assertPublicUserVisible('staff')).rejects.toMatchObject({ statusCode: 404 });
    await expect(usersService.getPublicProfile('partner', 'member')).rejects.toMatchObject({ statusCode: 404 });
    await expect(usersService.assertPublicUserVisible('member')).resolves.toBeUndefined();
  });
});

describe('stats endpoints', () => {
  const call = async (handler: 'headToHead' | 'recentMatches', query: Record<string, unknown>, callerId: string) => {
    const { statsController } = await import('../../src/modules/stats/stats.controller.js');
    const res = { json: vi.fn() } as unknown as Response;
    const req = { validated: { query }, user: { id: callerId } } as unknown as Request;
    await statsController[handler](req, res);
    return res;
  };

  it('refuse partner and staff target ids for anyone else', async () => {
    await expect(call('recentMatches', { userId: 'partner', limit: 5 }, 'member')).rejects.toMatchObject({ statusCode: 404 });
    await expect(call('headToHead', { userA: 'member', userB: 'staff' }, 'member')).rejects.toMatchObject({ statusCode: 404 });
    expect(stats.getRecentMatchesForUser).not.toHaveBeenCalled();
    expect(stats.getHeadToHead).not.toHaveBeenCalled();
  });

  it('let the partner player read their own history and members read members', async () => {
    await call('recentMatches', { userId: 'partner', limit: 5 }, 'partner');
    await call('headToHead', { userA: 'member', userB: 'member' }, 'member');
    expect(stats.getRecentMatchesForUser).toHaveBeenCalledWith('partner', 5);
    expect(stats.getHeadToHead).toHaveBeenCalled();
  });
});

describe('partner block hook', () => {
  const event = {
    slug: 'freecroco', environment: 'test' as const, playerId: 'p', externalPlayerId: 'x', userId: 'u',
    revokedSessionIds: ['s'], cancelledPlayIds: ['play'],
  };

  it('tells every subscriber; a failing one never fails the block; unsubscribe stops delivery', async () => {
    const seen: string[] = [];
    const off = onPartnerPlayerBlocked((e) => { seen.push(e.playerId); });
    const offBroken = onPartnerPlayerBlocked(() => { throw new Error('socket layer down'); });
    await expect(emitPartnerPlayerBlocked(event)).resolves.toBeUndefined();
    off();
    offBroken();
    await emitPartnerPlayerBlocked(event);
    expect(seen).toEqual(['p']);
  });
});

describe('partner janitor', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('runs on its interval and shutdown waits for a sweep in flight', async () => {
    vi.useFakeTimers();
    let finish!: (n: number) => void;
    sessions.forget.mockImplementation(() => new Promise<number>((resolve) => { finish = resolve; }));
    startPartnerJanitor();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sessions.forget).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = stopPartnerJanitor().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish(2);
    await stopping;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sessions.forget).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
