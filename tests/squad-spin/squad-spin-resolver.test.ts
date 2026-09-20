import { describe, expect, it } from 'vitest';
import { resolveSquadSpinAnswer } from '../../src/modules/squad-spin/squad-spin.resolver.js';
import type { SquadSpinAliasRow } from '../../src/modules/squad-spin/squad-spin.types.js';

const alias = (player_id: string, normalized_alias: string, acceptance_policy: SquadSpinAliasRow['acceptance_policy'] = 'unique_only', locale: SquadSpinAliasRow['locale'] = 'en'): SquadSpinAliasRow => ({ player_id, normalized_alias, locale, acceptance_policy });

const aliases: SquadSpinAliasRow[] = [
  alias('messi', 'lionel messi', 'exact'),
  alias('messi', 'messi'),
  alias('messi', 'ლიონელ მესი', 'exact', 'ka'),
  alias('messi', 'lionel messi', 'safe_typo'),
  alias('aguero', 'sergio aguero', 'exact'),
  alias('aguero', 'aguero'),
];

describe('squad-spin resolver', () => {
  it('accepts exact, surname, accented and Georgian spellings of a valid answer', () => {
    expect(resolveSquadSpinAnswer('Lionel Messi', aliases).playerId).toBe('messi');
    expect(resolveSquadSpinAnswer('  messi ', aliases).playerId).toBe('messi');
    expect(resolveSquadSpinAnswer('Sergio Agüero', aliases).playerId).toBe('aguero');
    expect(resolveSquadSpinAnswer('ლიონელ მესი', aliases).playerId).toBe('messi');
  });

  it('tolerates typos only through safe_typo aliases', () => {
    expect(resolveSquadSpinAnswer('Lionel Mesi', aliases).playerId).toBe('messi');
    expect(resolveSquadSpinAnswer('Sergio Aguerro', aliases).playerId).toBeNull();
  });

  it('rejects players outside the answer set and empty input', () => {
    expect(resolveSquadSpinAnswer('Ronaldo', aliases).playerId).toBeNull();
    expect(resolveSquadSpinAnswer('   ', aliases).playerId).toBeNull();
  });
});
