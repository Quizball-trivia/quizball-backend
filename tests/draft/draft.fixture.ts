import { universeOf, type DraftPack, type ServerUniverse } from '../../src/modules/draft/draft.universe.js';

/** An invented league: nothing here is a real club or player. */
export function inventedPack(): DraftPack {
  const leagues = [{ id: 'sol', name: 'Liga del Sol', short: 'SOL', teams: 8, games: 14 }];
  const clubs: DraftPack['clubs'] = [];
  const roles: Array<[string, 'GK' | 'DEF' | 'MID' | 'FWD']> = [['GK', 'GK'], ['GK', 'GK'], ['CB', 'DEF'], ['CB', 'DEF'], ['LB', 'DEF'], ['RB', 'DEF'], ['DM', 'MID'], ['CM', 'MID'], ['AM', 'MID'], ['LW', 'FWD'], ['RW', 'FWD'], ['CF', 'FWD'], ['CM', 'MID'], ['CB', 'DEF']];
  for (let c = 0; c < 12; c++) {
    for (let y = 0; y < 3; y++) {
      const year = 1998 + y * 8;
      clubs.push({
        league: 'sol', clubId: `sol-${c}`, club: `Invented Club ${c}`, year, finish: (c % 8) + 1,
        players: roles.map(([role, pos], i) => [`Invented ${c}${y} Player ${i}`, pos, null, 8 + ((c + i) % 7), pos === 'FWD' ? 3 + ((c + i) % 9) : 1, y === 0 ? null : (c + i) % 6, pos === 'GK' || pos === 'DEF' ? 2 + (c % 5) : 0, Math.min(1, 0.4 + ((c + i) % 6) / 10), `person-${c}-${i}`, c === 0 && i === 11 ? 1 : 0, role, 0]),
      });
    }
  }
  return { source: 'test', leagues, clubs };
}
export const inventedUniverse = (): ServerUniverse => universeOf(inventedPack());
