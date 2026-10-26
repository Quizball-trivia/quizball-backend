import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { refuseOverlap, writeLedger } from '../../src/modules/conexiones/conexiones.seed.js';
import type { CxBoard } from '../../src/modules/room/games/conexiones/conexiones.rules.js';

/**
 * Opt-in, real PostgreSQL (CONEXIONES_TEST_DATABASE_URL, an isolated local clone): the daily / room overlap ledger.
 * Invented players only.
 */
const url = process.env.CONEXIONES_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

const L = (en: string) => ({ en, es: en, ka: en, tr: en, ru: en });
/** A board whose group g holds the given players (the rest are fillers unique to the board). */
function board(id: string, groups: Array<{ key: string; players: string[] }>): CxBoard {
  const tiles: CxBoard['tiles'] = [];
  const out = groups.map((g, gi) => {
    const members = Array.from({ length: 4 }, (_, m) => {
      const player = g.players[m] ?? `${id}-filler-${gi}-${m}`;
      const tid = `${id}${gi}${m}`.replace(/[^a-z0-9]/g, '').padEnd(8, 'x').slice(-8);
      tiles.push({ id: tid, player, name: { en: `Invented ${player}`, ka: 'ka', ru: 'ru' }, portrait: null });
      return tid;
    });
    return { id: `${id}-g${gi + 1}`, tier: (gi + 1) as 1 | 2 | 3 | 4, key: g.key, link: L(g.key), decoys: [L('a'), L('b'), L('c')], members };
  });
  return { id, difficulty: 'medium', tiles, groups: out };
}
const fill = (id: string, first: { key: string; players: string[] }) => board(id, [first, { key: `club:x-${id}`, players: [] }, { key: `born:y-${id}`, players: [] }, { key: `wc:z-${id}`, players: [] }]);

describe.skipIf(!url)('Conexiones overlap ledger on real Postgres', () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(() => { sql = postgres(url!, { max: 2, onnotice: () => undefined }); });
  afterAll(async () => { if (!sql) return; await sql`DELETE FROM conexiones_ledger WHERE board_id LIKE 'tst%'`; await sql.end(); });
  beforeEach(async () => { await sql`DELETE FROM conexiones_ledger WHERE board_id LIKE 'tst%'`; });

  it('room boards that each show one member of a daily group under its link are refused together', async () => {
    await sql.begin((tx) => writeLedger(tx, 'daily', [{ board: fill('tstdaily', { key: 'club:napoli', players: ['pa', 'pb', 'pc', 'pd'] }), day: '2026-11-01' }]));
    const one = fill('tstroom1', { key: 'club:napoli', players: ['pa'] });
    await sql.begin(async (tx) => { await refuseOverlap(tx, 'room', [one]); await writeLedger(tx, 'room', [{ board: one }]); });
    // A second room board with another of the four under the same link: two of them are now out there.
    const two = fill('tstroom2', { key: 'club:napoli', players: ['pb'] });
    await expect(sql.begin((tx) => refuseOverlap(tx, 'room', [two]))).rejects.toThrow(/same link/);
    // The same footballer under another link is fine.
    await sql.begin((tx) => refuseOverlap(tx, 'room', [fill('tstroom3', { key: 'club:other', players: ['pb'] })]));
  });

  it('three footballers of one group together are refused under any link; names count like ids', async () => {
    await sql.begin((tx) => writeLedger(tx, 'room', [{ board: fill('tstpool', { key: 'wc:2014', players: ['qa', 'qb', 'qc', 'qd'] }) }]));
    await expect(sql.begin((tx) => refuseOverlap(tx, 'daily', [fill('tstday2', { key: 'born:1990', players: ['qa', 'qb', 'qc'] })]))).rejects.toThrow(/shares 3/);
    // Another source id, the same person by name.
    const renamed = fill('tstday3', { key: 'wc:2014', players: ['other-id-qa', 'qb'] });
    renamed.tiles[0] = { ...renamed.tiles[0], name: { ...renamed.tiles[0].name, en: 'Invented qa' } };
    await expect(sql.begin((tx) => refuseOverlap(tx, 'daily', [renamed]))).rejects.toThrow(/same link/);
  });

  it('a corrected link keeps both versions in the ledger', async () => {
    const before = fill('tstfix', { key: 'club:old', players: ['ra', 'rb', 'rc', 'rd'] });
    const after = fill('tstfix', { key: 'club:new', players: ['ra', 'rb', 'rc', 'rd'] });
    await sql.begin((tx) => writeLedger(tx, 'daily', [{ board: before, day: '2026-11-02' }]));
    await sql.begin((tx) => writeLedger(tx, 'daily', [{ board: after, day: '2026-11-02' }]));
    const keys = await sql<Array<{ link_key: string }>>`SELECT DISTINCT link_key FROM conexiones_ledger WHERE board_id = 'tstfix' AND group_id = 'tstfix-g1' ORDER BY 1`;
    expect(keys.map((k) => k.link_key)).toEqual(['club:new', 'club:old']);
  });
});
