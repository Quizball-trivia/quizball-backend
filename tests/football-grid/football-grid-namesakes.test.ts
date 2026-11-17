import { describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { footballGridRepo } from '../../src/modules/football-grid/football-grid.repo.js';
import { footballGridNamesakes } from '../../src/modules/football-grid/football-grid-namesakes.js';
import { footballGridMatchKey, normalizeFootballGridAnswer } from '../../src/modules/football-grid/football-grid.answer-resolver.js';

const key = (name: string) => footballGridMatchKey(normalizeFootballGridAnswer(name));

describe('football grid namesake index', () => {
  it('loads every footballer name in the background and never blocks a lookup', async () => {
    const pages = vi.spyOn(footballGridRepo, 'getFootballerNamesPage').mockImplementation(async (after) => (after === null
      ? [{ id: 'a1', name: 'Jorvo Kelmet' }, { id: 'a2', name: 'Ødo Varn' }]
      : []));
    const ids = (name: string) => footballGridNamesakes.holders(key(name)).map((holder) => holder.playerId);
    expect(ids('Jorvo Kelmet')).toEqual([]);
    await vi.waitFor(() => expect(ids('Jorvo Kelmet')).toEqual(['a1']));
    expect(ids('Odo Varn')).toEqual(['a2']);
    expect(footballGridNamesakes.holders(key('Odo Varn'))[0].raw).toBe('ødo varn');
    expect(pages).toHaveBeenCalledTimes(1);
    pages.mockRestore();
  });
});
