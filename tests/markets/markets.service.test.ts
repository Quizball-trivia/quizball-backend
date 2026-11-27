import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const listMock = vi.hoisted(() => vi.fn());
const listPlayerCountriesMock = vi.hoisted(() => vi.fn());
const currentCountriesMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/modules/markets/markets.repo.js', () => ({
  marketsRepo: { list: listMock, listPlayerCountries: listPlayerCountriesMock },
}));

vi.mock('../../src/realtime/session-country.js', () => ({
  getCurrentCountriesForUsers: currentCountriesMock,
}));

import { invalidateMarketsCache, marketsService } from '../../src/modules/markets/markets.service.js';

const DEFINITIONS = [
  { code: 'ge', name: 'Georgia', countries: ['GE'] },
  { code: 'tr', name: 'Turkey', countries: ['TR'] },
];

describe('marketsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateMarketsCache();
    listMock.mockResolvedValue(DEFINITIONS);
    currentCountriesMock.mockResolvedValue(new Map());
  });

  it('uses the profile country of each real player', async () => {
    listPlayerCountriesMock.mockResolvedValue([
      { id: 'a', country: 'GE' },
      { id: 'b', country: 'DE' },
    ]);

    await expect(marketsService.forPlayers(['a', 'b'])).resolves.toEqual(['ge', null]);
    expect(currentCountriesMock).not.toHaveBeenCalled();
  });

  it('falls back to where a player is playing from when the profile has no country', async () => {
    listPlayerCountriesMock.mockResolvedValue([
      { id: 'a', country: null },
      { id: 'b', country: 'GE' },
    ]);
    currentCountriesMock.mockResolvedValue(new Map([['a', 'TR']]));

    await expect(marketsService.forPlayers(['a', 'b'])).resolves.toEqual(['tr', 'ge']);
    expect(currentCountriesMock).toHaveBeenCalledWith(['a']);
  });

  it('leaves out bots: only players the repo returns are counted', async () => {
    listPlayerCountriesMock.mockResolvedValue([{ id: 'human', country: 'GE' }]);

    await expect(marketsService.forPlayers(['human', 'bot'])).resolves.toEqual(['ge']);
  });

  it('has nobody to speak for when there are no players', async () => {
    await expect(marketsService.forPlayers([])).resolves.toEqual([]);
    expect(listPlayerCountriesMock).not.toHaveBeenCalled();
  });

  it('treats every player as having no market when markets cannot be read', async () => {
    listMock.mockRejectedValue(new Error('database is away'));
    listPlayerCountriesMock.mockResolvedValue([{ id: 'a', country: 'GE' }]);

    await expect(marketsService.forPlayers(['a', 'b'])).resolves.toEqual([null, null]);
    await expect(marketsService.forCountry('GE')).resolves.toBeNull();
  });

  it('reads the definitions once and reuses them', async () => {
    listPlayerCountriesMock.mockResolvedValue([{ id: 'a', country: 'GE' }]);

    await marketsService.forPlayers(['a']);
    await marketsService.forCountry('TR');
    await marketsService.list();

    expect(listMock).toHaveBeenCalledTimes(1);
  });
});
