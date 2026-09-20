import { describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({ rows: new Map<string, { id: string; token_hash: string; locale: string | null; linked_user_id: string | null; created_at: string; last_seen_at: string }>() }));
vi.mock('../../src/modules/guest/guest.repo.js', () => ({
  guestRepo: {
    insert: async (data: { tokenHash: string; locale: string | null }) => {
      const row = { id: `g-${repo.rows.size + 1}`, token_hash: data.tokenHash, locale: data.locale, linked_user_id: null, created_at: 'now', last_seen_at: 'now' };
      repo.rows.set(data.tokenHash, row);
      return row;
    },
    findByTokenHash: async (hash: string) => repo.rows.get(hash) ?? null,
    touch: async () => undefined,
  },
}));

const { guestService } = await import('../../src/modules/guest/guest.service.js');

describe('guest sessions', () => {
  it('mints an opaque 64-hex token and stores only its hash', async () => {
    const { token, guestId } = await guestService.createSession({ locale: 'en', ip: '1.2.3.4', deviceId: 'dev' });
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect([...repo.rows.keys()]).not.toContain(token);
    expect((await guestService.resolve(token)).id).toBe(guestId);
  });

  it('rejects missing, malformed and unknown tokens', async () => {
    await expect(guestService.resolve(undefined)).rejects.toThrow('Missing guest token');
    await expect(guestService.resolve('not-a-token')).rejects.toThrow('Missing guest token');
    await expect(guestService.resolve('f'.repeat(64))).rejects.toThrow('Unknown guest token');
  });
});
