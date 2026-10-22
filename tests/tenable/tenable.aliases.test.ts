import { describe, expect, it } from 'vitest';
import { mergeAliases } from '../../src/modules/tenable/tenable.aliases.js';
import { buildDirectory, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';

// Invented nations only: the repository is public.
const E = (eid: string, name: string, known: string, aliases: string[] = []): TenableEntity => ({ eid, name, known, fame: 50, aliases, qualifier: null });
const NATIONS = [E('n-north', 'Northland', 'Northland', ['Norteland']), E('n-vale', 'Valeria', 'Valeria')];

describe('Tenable alias sets', () => {
  it('add a language\'s spellings once, after the entity\'s own', () => {
    const merged = mergeAliases(NATIONS, [{ eid: 'n-north', aliases: ['Terra do Norte', 'norteland'] }, { eid: 'n-north', aliases: ['Terra do Norte'] }]);
    expect(merged[0].aliases).toEqual(['Norteland', 'Terra do Norte']);
    expect(merged[1]).toBe(NATIONS[1]);
  });

  it('make the Portuguese spelling an answer for that entity', () => {
    const directory = buildDirectory('nation', 'rel', mergeAliases(NATIONS, [{ eid: 'n-vale', aliases: ['Valéria do Sul'] }]));
    expect(directory.identify('valeria do sul')).toMatchObject({ kind: 'entity', eid: 'n-vale' });
  });
});
