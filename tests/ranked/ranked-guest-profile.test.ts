import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/core/json-cache.js', () => ({ deleteJsonCacheKeys: vi.fn(), getOrLoadJson: <T>(_k: string, _t: number, l: () => Promise<T>) => l() }));
vi.mock('../../src/modules/matches/matches.repo.js', () => ({ matchesRepo: { getMatch: vi.fn() } }));
vi.mock('../../src/modules/matches/match-players.repo.js', () => ({ matchPlayersRepo: { listMatchPlayers: vi.fn() } }));
const getById = vi.fn();
vi.mock('../../src/modules/users/users.repo.js', () => ({ usersRepo: { getById, getByIds: vi.fn() } }));
const ensureProfileRepo = vi.fn();
vi.mock('../../src/modules/ranked/ranked.repo.js', () => ({ rankedRepo: { ensureProfile: ensureProfileRepo, normalizeTier: vi.fn(), getProfilesByUserIds: vi.fn().mockResolvedValue([]) } }));
vi.mock('../../src/modules/bots/governor/governor.service.js', () => ({ governorService: {} }));
vi.mock('../../src/modules/store/store.repo.js', () => ({ storeRepo: {} }));

const { rankedService } = await import('../../src/modules/ranked/ranked.service.js');

describe('rankedService.ensureProfile — guests', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a synthetic unplaced profile for a guest and never inserts a row', async () => {
    getById.mockResolvedValue({ id: 'g-user', is_guest: true });
    const profile = await rankedService.ensureProfile('g-user');
    expect(profile).toMatchObject({ user_id: 'g-user', rp: 450, placement_status: 'unplaced', placement_played: 0 });
    expect(ensureProfileRepo).not.toHaveBeenCalled();
    const batch = await rankedService.ensureProfiles(['g-user']);
    expect(batch.get('g-user')?.rp).toBe(450);
    expect(ensureProfileRepo).not.toHaveBeenCalled();
  });

  it('still creates real profiles for members', async () => {
    getById.mockResolvedValue({ id: 'm-user', is_guest: false });
    ensureProfileRepo.mockResolvedValue({ user_id: 'm-user', rp: 450, tier: 'Youth Prospect' });
    await rankedService.ensureProfile('m-user');
    expect(ensureProfileRepo).toHaveBeenCalledWith('m-user');
  });
});
