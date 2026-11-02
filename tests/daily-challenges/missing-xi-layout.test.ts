import { describe, expect, it } from 'vitest';

import {
  MISSING_XI_LAYOUT_VERSION,
  missingXiLineCode,
  missingXiServedSlots,
  needsMissingXiLayoutRepair,
} from '../../src/modules/daily-challenges/missing-xi-layout.js';

type Slot = { id: string; name: string; position: string; x: number; y: number };

/** Real Madrid, 2016 Champions League final, exactly as the UEFA-verified content stored it (mirrored). */
const realMadrid2016Stored: Slot[] = [
  { id: 'gk0', name: 'Keylor Navas', position: 'GK', x: 50, y: 90 },
  { id: 'lb1', name: 'Daniel Carvajal', position: 'LB', x: 14, y: 72 },
  { id: 'cb2', name: 'Sergio Ramos', position: 'CB', x: 38, y: 72 },
  { id: 'cb3', name: 'Pepe', position: 'CB', x: 62, y: 72 },
  { id: 'rb4', name: 'Marcelo', position: 'RB', x: 86, y: 72 },
  { id: 'dm5', name: 'Casemiro', position: 'DM', x: 50, y: 55 },
  { id: 'lw6', name: 'Luka Modrić', position: 'LW', x: 33, y: 40 },
  { id: 'rw7', name: 'Toni Kroos', position: 'RW', x: 67, y: 40 },
  { id: 'lw8', name: 'Gareth Bale', position: 'LW', x: 22, y: 27 },
  { id: 'cf9', name: 'Karim Benzema', position: 'CF', x: 50, y: 27 },
  { id: 'rw10', name: 'Cristiano Ronaldo', position: 'RW', x: 78, y: 27 },
];

const byName = (slots: Slot[]) => new Map(slots.map((slot) => [slot.name, slot]));

describe('Missing XI layout repair', () => {
  it('puts UEFA-sourced full-backs and wingers back on their real flanks', () => {
    const served = byName(missingXiServedSlots({ slots: realMadrid2016Stored, verified: { source: 'uefa' } }));

    expect(served.get('Daniel Carvajal')).toMatchObject({ position: 'RB', x: 86 });
    expect(served.get('Marcelo')).toMatchObject({ position: 'LB', x: 14 });
    expect(served.get('Cristiano Ronaldo')).toMatchObject({ position: 'LW', x: 22 });
    expect(served.get('Gareth Bale')).toMatchObject({ position: 'RW', x: 78 });
    expect(served.get('Keylor Navas')).toMatchObject({ position: 'GK', x: 50, y: 90 });
    // The pair behind a front three are central midfielders, not wingers.
    expect(served.get('Luka Modrić')).toMatchObject({ position: 'CM', x: 67 });
    expect(served.get('Toni Kroos')).toMatchObject({ position: 'CM', x: 33 });
    expect(served.get('Casemiro')?.position).toBe('DM');
  });

  it('keeps slot ids and order stable', () => {
    const served = missingXiServedSlots({ slots: realMadrid2016Stored, verified: { source: 'uefa' } });
    expect(served.map((slot) => slot.id)).toEqual(realMadrid2016Stored.map((slot) => slot.id));
  });

  it('leaves Wikipedia / Transfermarkt layouts and already-fixed payloads untouched', () => {
    expect(needsMissingXiLayoutRepair({ slots: realMadrid2016Stored, verified: { source: 'wikipedia' } })).toBe(false);
    expect(needsMissingXiLayoutRepair({ slots: realMadrid2016Stored, verified: null })).toBe(false);
    expect(
      needsMissingXiLayoutRepair({ slots: realMadrid2016Stored, verified: { source: 'uefa' }, layout_version: MISSING_XI_LAYOUT_VERSION })
    ).toBe(false);
    const fixed = missingXiServedSlots({ slots: realMadrid2016Stored, verified: { source: 'uefa' }, layout_version: 2 });
    expect(fixed).toBe(realMadrid2016Stored);
  });

  it('only gives a side to genuinely wide roles', () => {
    const codes = (sizes: number[]) => sizes.map((n, line) => Array.from({ length: n }, (_, j) => missingXiLineCode(line, j, n, sizes)));
    expect(codes([4, 2, 3, 1])).toEqual([['LB', 'CB', 'CB', 'RB'], ['DM', 'DM'], ['LW', 'AM', 'RW'], ['CF']]);
    expect(codes([4, 3, 3])).toEqual([['LB', 'CB', 'CB', 'RB'], ['CM', 'CM', 'CM'], ['LW', 'CF', 'RW']]);
    expect(codes([4, 4, 2])).toEqual([['LB', 'CB', 'CB', 'RB'], ['LM', 'CM', 'CM', 'RM'], ['CF', 'CF']]);
    expect(codes([3, 5, 2])).toEqual([['CB', 'CB', 'CB'], ['LM', 'CM', 'CM', 'CM', 'RM'], ['CF', 'CF']]);
  });
});
