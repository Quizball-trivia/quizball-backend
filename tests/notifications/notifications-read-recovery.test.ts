import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const repo = vi.hoisted(() => ({ listForUser: vi.fn(), unreadCount: vi.fn(), insert: vi.fn() }));
vi.mock('../../src/modules/notifications/notifications.repo.js', () => ({ notificationsRepo: repo }));
vi.mock('../../src/realtime/services/notifications-realtime.service.js', () => ({ emitNotificationNew: vi.fn(), emitNotificationUnreadCount: vi.fn() }));
import { notificationsService } from '../../src/modules/notifications/notifications.service.js';
const poolError = () => Object.assign(new Error('(EAUTHPROTOCOL) protocol violation during authentication'), { code: '08P01' });
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());
it('recovers the notification list when the first database handshake fails', async () => {
  repo.listForUser.mockRejectedValueOnce(poolError()).mockResolvedValueOnce([]);
  repo.unreadCount.mockResolvedValue(0);
  const result = notificationsService.listForUser('qa-user', { limit: 20 });
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toEqual({ items: [], unreadCount: 0 });
  expect(repo.listForUser).toHaveBeenCalledTimes(2);
});
it('recovers the read-only unread counter independently', async () => {
  repo.unreadCount.mockRejectedValueOnce(poolError()).mockResolvedValueOnce(3);
  const result = notificationsService.unreadCount('qa-user');
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBe(3);
});
it('does not replay notification writes', async () => {
  const error = poolError(); repo.insert.mockRejectedValue(error);
  await expect(notificationsService.notify('qa-user', { type: 'announcement', title: { en: 'QA' } } as never)).rejects.toBe(error);
  expect(repo.insert).toHaveBeenCalledTimes(1);
});
