import { describe, expect, it } from 'vitest';
import { auditGridLocaleCoverage } from '../../scripts/football-grid-locale-coverage.js';
import { normalizeFootballGridAnswer } from '../../src/modules/football-grid/football-grid.answer-resolver.js';
import type { Manifest } from '../../scripts/football-grid-content.js';

const player = { id: 'p', nameEn: 'Rıdvan Yılmaz', nameKa: 'რიდვან ილმაზი', imageAssetKey: 'portrait' };
const alias = (name: string, locale: 'en' | 'ka'): Manifest['aliases'][number] => ({
  playerId: player.id, alias: name, normalizedAlias: normalizeFootballGridAnswer(name),
  locale, aliasType: 'full_name', acceptancePolicy: 'exact', reviewedBy: 'fixture', reviewedAt: '2026-09-22T00:00:00Z',
});

describe('offline locale coverage', () => {
  it('checks Latin keyboard variants and both Georgian case forms', () => {
    expect(auditGridLocaleCoverage({ players: [player], aliases: [alias(player.nameEn, 'en'), alias(player.nameKa, 'ka')] }))
      .toMatchObject({ players: 1, checkedForms: 5, failures: [] });
  });
  it('reports a missing Georgian identity rather than claiming Latin fallback is Georgian coverage', () => {
    const result = auditGridLocaleCoverage({ players: [player], aliases: [alias(player.nameEn, 'en')] });
    expect(result.failures.map((failure) => failure.form)).toEqual(['georgian', 'georgian-uppercase']);
  });
});
