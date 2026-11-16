import { describe, expect, it } from 'vitest';
import { buildDirectory, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';

// Invented clubs and countries only: the repository is public.
const E = (eid: string, name: string, known: string, fame: number, aliases: string[] = []): TenableEntity => ({ eid, name, known, fame, aliases, qualifier: null });
const clubs = buildDirectory('club', 'rel', [
  E('vil', 'Vellmora CF', 'Vellmora', 70), E('lis', 'Lissandra F.C.', 'Lissandra', 60), E('dor', 'FC Dorvia Kalbi', 'Dorvia Kalbi', 30),
  E('ast', 'Astor S.K.', 'Astor', 20), E('ast2', 'Astor United', 'Astor United', 10),
]);
const nations = buildDirectory('nation', 'rel', [E('ves', 'Vestria', 'Vestria', 80)]);
const managers = buildDirectory('manager', 'rel', [E('m1', 'Club Vellmora', 'Vellmora', 50)]);

describe('Tenable clubs and national teams: generic team words never decide', () => {
  it('a club written with or without its generic words is that club', () => {
    expect(clubs.identify('FC Vellmora')).toEqual({ kind: 'entity', eid: 'vil' });
    expect(clubs.identify('Lissandra Football Club')).toEqual({ kind: 'entity', eid: 'lis' });
    expect(clubs.identify('SK Dorvia Kalbbi')).toEqual({ kind: 'entity', eid: 'dor' });
    expect(nations.identify("équipe de Vestria de football")).toEqual({ kind: 'entity', eid: 'ves' });
    expect(nations.identify("Vestria men's national football team")).toEqual({ kind: 'entity', eid: 'ves' });
  });

  it('a name the release knows is never stripped, and stripping keeps the shared-name rules', () => {
    expect(clubs.identify('Astor United')).toEqual({ kind: 'entity', eid: 'ast2' });
    expect(clubs.identify('Astor')).toEqual({ kind: 'entity', eid: 'ast' });
    expect(clubs.identify('FC Club')).toEqual({ kind: 'unknown' });
    expect(clubs.identify('Football Club Nowhere')).toEqual({ kind: 'unknown' });
    // A lone letter is a side of its own (a reserve team), never a generic word.
    expect(clubs.identify('Football Club Vellmora B')).toEqual({ kind: 'unknown' });
    expect(clubs.identify("Football Club Vellmora men's B")).toEqual({ kind: 'unknown' });
    expect(clubs.identify('Astor S.K.')).toEqual({ kind: 'entity', eid: 'ast' });
    expect(clubs.identify('A.S. Lissandra')).toEqual({ kind: 'entity', eid: 'lis' });
  });

  it('only clubs and national teams', () => {
    expect(managers.identify('FC Vellmora')).toEqual({ kind: 'unknown' });
  });
});
