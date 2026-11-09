import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/core/config.js';
import { logger } from '../../src/core/logger.js';
import { recordRoomLifecycle, roomLifecycleKey } from '../../src/core/room-lifecycle.js';

vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn() } }));

describe('room lifecycle history privacy and failure isolation', () => {
  beforeEach(() => { vi.mocked(logger.info).mockReset(); });
  it('correlates the same invite regardless of casing, with separate keyed member signals', () => {
    expect(roomLifecycleKey('invite', ' abC123 ')).toBe(roomLifecycleKey('invite', 'ABC123'));
    expect(roomLifecycleKey('invite', 'ABC123')).toMatch(/^[a-f0-9]{32}$/);
    expect(roomLifecycleKey('invite', 'ABC123')).not.toBe(roomLifecycleKey('member', 'ABC123'));
    expect(roomLifecycleKey('invite', 'ABC123')).not.toBe(roomLifecycleKey('invite', 'XYZ789'));
  });
  it('records useful deletion context without raw codes, members, names or credentials', () => {
    recordRoomLifecycle('deleted', {
      id: 'room-id', invite_code: 'ABC123', mode: 'friendly', status: 'waiting',
      game_mode: 'auction', is_public: false, created_at: new Date(Date.now() - 300000).toISOString(),
      hostNickname: 'private-name', token: 'private-token',
    } as never, { userId: 'private-member-id', reason: 'disconnect_reservation_expired' });
    const call = vi.mocked(logger.info).mock.calls[0];
    expect(call[0]).toMatchObject({ event: 'room_lifecycle', action: 'deleted', lobbyId: 'room-id', reason: 'disconnect_reservation_expired', gameMode: 'auction', isPublic: false });
    const output = JSON.stringify(call);
    for (const value of ['ABC123', 'private-name', 'private-token', 'private-member-id', config.SUPABASE_JWT_SECRET!]) expect(output).not.toContain(value);
  });
  it('does not change a room operation if logging fails and keeps ranked creation out of this history', () => {
    vi.mocked(logger.info).mockImplementation(() => { throw new Error('log transport unavailable'); });
    expect(() => recordRoomLifecycle('created', { id: 'friendly-room', mode: 'friendly' })).not.toThrow();
    vi.mocked(logger.info).mockClear();
    recordRoomLifecycle('created', { id: 'ranked-room', mode: 'ranked' });
    expect(logger.info).not.toHaveBeenCalled();
  });
});
