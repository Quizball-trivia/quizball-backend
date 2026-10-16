import { beforeEach, describe, expect, it, vi } from 'vitest';

const pool = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/index.js', () => ({ sql: pool }));

import { clearRaceTournamentCache, loadRaceTournament } from '../../src/modules/room/games/football-race/football-race.releases.js';

// INVENTED tournament (public repo): the smallest data the strict schema accepts.
const L = (en: string) => ({ en, es: en, ka: en, tr: en });
const payload = {
  release: 'test-1', cutoff: '2031-01-01', source: L('Invented'), tournament: { id: 'TT', label: L('Invented Cup') },
  nations: ['A', 'B'].map((id, tier) => ({ id, code: `${id}XX`, flag: 'xx', name: L(id), tier })),
  scopes: [{ id: 'TT.all', label: L('All-time') }], families: [{ id: 'results', label: L('Results') }],
  metrics: [{ id: 'wins', family: 'results', dir: 'high', unwanted: false, decimals: 0, kind: 'count', label: L('Wins'), keywords: '' }],
  stats: [{ id: 'TT.all:wins', scope: 'TT.all', metric: 'wins', values: { A: 3, B: 1 } }],
};

describe('football race release loader', () => {
  beforeEach(() => { clearRaceTournamentCache(); pool.mockReset(); });

  it('a cold load under a match lock reads through that transaction, never a second pooled connection', async () => {
    const tx = vi.fn(async () => [{ payload }]);
    const data = await loadRaceTournament('test-1', 'TT', tx as never);
    expect(data.tournament.id).toBe('TT');
    expect(tx).toHaveBeenCalledTimes(1);
    expect(pool).not.toHaveBeenCalled();
  });

  it('a transaction never waits on a pooled load already in flight; it reads through itself', async () => {
    let release!: (rows: unknown) => void;
    pool.mockImplementation(() => new Promise((done) => { release = done; }));
    const pooled = loadRaceTournament('test-1', 'TT');
    const tx = vi.fn(async () => [{ payload }]);
    const data = await loadRaceTournament('test-1', 'TT', tx as never);
    expect(data.tournament.id).toBe('TT');
    expect(tx).toHaveBeenCalledTimes(1);
    release([{ payload }]);
    await expect(pooled).resolves.toMatchObject({ release: 'test-1' });
  });

  it('a warm load touches neither; without a transaction a cold load uses the pool', async () => {
    pool.mockImplementation(async () => [{ payload }]);
    await loadRaceTournament('test-1', 'TT');
    expect(pool).toHaveBeenCalledTimes(1);
    const tx = vi.fn();
    await loadRaceTournament('test-1', 'TT', tx as never);
    expect(tx).not.toHaveBeenCalled();
    expect(pool).toHaveBeenCalledTimes(1);
  });
});
