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

const players = [
  { id: 'messi', name_en: 'Lionel Messi', name_ka: 'ლიონელ მესი' },
  { id: 'aguero', name_en: 'Sergio Agüero', name_ka: null },
];

describe('squad-spin resolver', () => {
  it('accepts exact, surname, accented and Georgian spellings of a valid answer', () => {
    expect(resolveSquadSpinAnswer('Lionel Messi', aliases, players).playerId).toBe('messi');
    expect(resolveSquadSpinAnswer('  messi ', aliases, players).playerId).toBe('messi');
    expect(resolveSquadSpinAnswer('Sergio Agüero', aliases, players).playerId).toBe('aguero');
    expect(resolveSquadSpinAnswer('ლიონელ მესი', aliases, players).playerId).toBe('messi');
  });

  it('tolerates typos against any valid-answer form', () => {
    expect(resolveSquadSpinAnswer('Lionel Mesi', aliases, players).playerId).toBe('messi');
    expect(resolveSquadSpinAnswer('Sergio Aguerro', aliases, players).playerId).toBe('aguero');
  });

  it('rejects players outside the answer set and empty input', () => {
    expect(resolveSquadSpinAnswer('Ronaldo', aliases, players).playerId).toBeNull();
    expect(resolveSquadSpinAnswer('   ', aliases, players).playerId).toBeNull();
  });

  // Regression: live losses on 2026-09-30 — the alias release has no surname
  // form for ~40% of players and none for compound surnames, so typed surnames
  // of valid answers were rejected even though the reveal then showed them.
  it('accepts a surname when the alias release lacks a surname alias', () => {
    const sparseAliases = [
      alias('tonali', 'sandro tonali', 'exact'),
      alias('tonali', 'tonali sandro'),
      alias('funes-mori', 'ramiro funes mori', 'exact'),
      alias('funes-mori', 'ramiro'),
    ];
    const sparsePlayers = [
      { id: 'tonali', name_en: 'Sandro Tonali', name_ka: 'სანდრო ტონალი' },
      { id: 'funes-mori', name_en: 'Ramiro Funes Mori', name_ka: null },
    ];
    expect(resolveSquadSpinAnswer('tonali', sparseAliases, sparsePlayers).playerId).toBe('tonali');
    expect(resolveSquadSpinAnswer('FUNES MORI', sparseAliases, sparsePlayers).playerId).toBe('funes-mori');
    expect(resolveSquadSpinAnswer('mori', sparseAliases, sparsePlayers).playerId).toBe('funes-mori');
    expect(resolveSquadSpinAnswer('ტონალი', sparseAliases, sparsePlayers).playerId).toBe('tonali');
  });

  it('folds Turkish dotless-ı keyboard variants like the live Grid', () => {
    const tr = [{ id: 'yildiz', name_en: 'Kenan Yildiz', name_ka: null }];
    expect(resolveSquadSpinAnswer('yıldız', [], tr).playerId).toBe('yildiz');
    expect(resolveSquadSpinAnswer('Kenan Yıldız', [], tr).playerId).toBe('yildiz');
  });

  it('matches suffix name forms only, never a bare particle or first-name-only prefix of a compound name', () => {
    const vanDijk = [{ id: 'vvd', name_en: 'Virgil van Dijk', name_ka: null }];
    expect(resolveSquadSpinAnswer('van dijk', [], vanDijk).playerId).toBe('vvd');
    expect(resolveSquadSpinAnswer('dijk', [], vanDijk).playerId).toBe('vvd');
    expect(resolveSquadSpinAnswer('van', [], vanDijk).playerId).toBeNull();
  });
});
