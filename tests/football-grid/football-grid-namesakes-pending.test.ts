import { describe, expect, it } from 'vitest';
import {
  footballGridNameUniverse, footballGridUniverseSnapshot, normalizeFootballGridAnswer, resolveFootballGridAnswer, type FootballGridNameUniverse,
} from '../../src/modules/football-grid/football-grid.answer-resolver.js';
import type { FootballGridAliasRecord } from '../../src/modules/football-grid/football-grid.types.js';

// Invented footballers only: this repository is public.
const alias = (playerId: string, text: string): FootballGridAliasRecord => ({
  id: `${playerId}:${text}`, playerId, alias: text, normalizedAlias: normalizeFootballGridAnswer(text), locale: 'en', acceptancePolicy: 'exact',
});

describe('Grid: no typo before every footballer\'s name is loaded', () => {
  const resolve = (text: string, more: FootballGridNameUniverse) => resolveFootballGridAnswer({
    submittedText: text, aliases: [alias('v', 'Delvan Oskaro')], validPlayerIds: ['v'], boardPlayerIds: ['v'], usedPlayerIds: [],
    validPlayerNames: [], universe: footballGridUniverseSnapshot(footballGridNameUniverse([new Map()], more)),
  }).outcome;
  let loaded = false;
  const namesakes: FootballGridNameUniverse = { holders: () => [], pending: () => !loaded };

  it('while loading only exact names count; once loaded typos are forgiven again', () => {
    expect(resolve('Delvan Oskaro', namesakes)).toBe('correct');
    expect(resolve('Delvan Oskar', namesakes)).toBe('wrong');
    loaded = true;
    expect(resolve('Delvan Oskar', namesakes)).toBe('correct');
  });
});
