import { describe, expect, it } from 'vitest';
import { resolveSquadSpinAnswer } from '../../src/modules/squad-spin/squad-spin.resolver.js';
import { footballerNamesOf } from '../../src/modules/footballers/footballers.names.js';
import { buildGreekIndex, type UniversePlayer } from '../../src/modules/footballers/footballers.universe.js';
import { NAMES, UNIVERSE } from '../footballers/names-fixture.js';

// Invented names only (tests/footballers/names-fixture.ts).
const resolve = (text: string, players: Array<{ id: string; name_en: string }>, names = NAMES) => resolveSquadSpinAnswer(text, [], players, names).playerId;

describe('Squad Spin: footballer names', () => {
  it('a typo that is another footballer\'s exact name is refused; plain typos still count', () => {
    expect(resolve('Tamas Varnik', [{ id: 'var-a', name_en: 'Tomas Varnik' }])).toBeNull();
    expect(resolve('Tamas Varnik', [{ id: 'var-a', name_en: 'Tomas Varnik' }], null)).toBe('var-a');
    expect(resolve('Tomas Varnk', [{ id: 'var-a', name_en: 'Tomas Varnik' }])).toBe('var-a');
  });

  it('a name of several words cut from a longer one is refused when it names someone else; a surname is not', () => {
    expect(resolve('Arlan Moss', [{ id: 'mos-a', name_en: 'Teo Arlan Moss' }])).toBeNull();
    expect(resolve('Moss', [{ id: 'mos-a', name_en: 'Teo Arlan Moss' }])).toBe('mos-a');
    expect(resolve('Arlan Moss', [{ id: 'mos-a', name_en: 'Teo Arlan Moss' }, { id: 'mos-b', name_en: 'Arlan Moss' }])).toBe('mos-b');
  });

  it('a name the footballer release gives a valid answer counts', () => {
    expect(resolve('Benn Dak', [{ id: 'dak-a', name_en: 'Benn Gallo-Dak' }])).toBe('dak-a');
    expect(resolve('Benn Dak', [{ id: 'var-a', name_en: 'Tomas Varnik' }])).toBeNull();
    // Also somebody else's own name: not credited.
    expect(resolve('Maelo', [{ id: 'mae-a', name_en: 'Rui Pando' }])).toBeNull();
    // …nor through a typo of another valid answer.
    expect(resolve('Maelo', [{ id: 'mae-a', name_en: 'Rui Pando' }, { id: 'x', name_en: 'Maela' }])).toBeNull();
    // A letter of another script is never dropped to leave a name behind.
    expect(resolve('Саро Velmar', [{ id: 'vel-a', name_en: 'Taro Velmar' }])).toBeNull();
  });

  it('letters Unicode cannot strip fold to plain ones', () => {
    expect(resolve('Lars Ostergard', [{ id: 'ost-a', name_en: 'Lars Østergard' }], null)).toBe('ost-a');
    expect(resolve('Ostergard', [{ id: 'ost-a', name_en: 'Lars Østergard' }], null)).toBe('ost-a');
  });
});

describe('Squad Spin: Greek names', () => {
  // Invented Greek spellings: both Varniks share the Greek surname, as they share the Latin one.
  const P = (pid: string, name: string, fame: number): UniversePlayer => ({ pid, name, game: name.split(' ').pop()!, fame, aliases: [] });
  const WITH_GREEK = footballerNamesOf(UNIVERSE, buildGreekIndex('el-1', [P('var-a', 'Τόμας Βάρνικ', 70), P('var-b', 'Τάμας Βάρνικ', 10)]));
  const valid = [{ id: 'var-a', name_en: 'Tomas Varnik', name_el: 'Τόμας Βάρνικ' }];

  it('a valid answer\'s Greek surname counts although another footballer shares it, as the Latin one does', () => {
    expect(resolve('Varnik', valid, WITH_GREEK)).toBe('var-a');
    expect(resolve('Βάρνικ', valid, WITH_GREEK)).toBe('var-a');
    // Without its Greek name the answer is only reachable through the names, which give the surname to both.
    expect(resolve('Βάρνικ', [{ id: 'var-a', name_en: 'Tomas Varnik' }], WITH_GREEK)).toBeNull();
  });

  it('the full Greek name counts without accents and with a final σ; another footballer\'s Greek name does not', () => {
    expect(resolve('τομασ βαρνικ', valid, WITH_GREEK)).toBe('var-a');
    expect(resolve('ΤΟΜΑΣ ΒΑΡΝΙΚ', valid, WITH_GREEK)).toBe('var-a');
    expect(resolve('Τάμας Βάρνικ', valid, WITH_GREEK)).toBeNull();
  });
});
