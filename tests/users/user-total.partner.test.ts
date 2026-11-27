import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

const h = vi.hoisted(() => ({
  getUserTotal: vi.fn(async () => ({ registered: 900, guestsPlayed: 150, converters: 50, total: 1000 })),
  readPartnerSnapshot: vi.fn(),
}));
vi.mock('../../src/modules/users/users.repo.js', () => ({ usersRepo: { getUserTotal: h.getUserTotal } }));
vi.mock('../../src/modules/partner-stats/partner-totals.js', () => ({ readPartnerSnapshot: h.readPartnerSnapshot }));
const { usersService } = await import('../../src/modules/users/users.service.js');
const { adminUserTotalResponseSchema } = await import('../../src/modules/users/users.schemas.js');

describe('admin user total with Table Derby', () => {
  it('adds Table Derby players ever registered to the total, keeping the parts', async () => {
    h.readPartnerSnapshot.mockResolvedValue({ totalUsers: 500 });
    const total = await usersService.getUserTotalForAdmin(new Date('2026-11-27T10:00:00Z'));
    expect(total).toEqual({ registered: 900, guestsPlayed: 150, converters: 50, tableDerby: 500, total: 1500 });
    expect(h.readPartnerSnapshot).toHaveBeenCalledWith('2026-11-27');
    expect(adminUserTotalResponseSchema.parse(total)).toEqual(total);
  });

  it('is Quizball alone before the first sync', async () => {
    h.readPartnerSnapshot.mockResolvedValue(null);
    expect(await usersService.getUserTotalForAdmin()).toMatchObject({ tableDerby: 0, total: 1000 });
  });
});
