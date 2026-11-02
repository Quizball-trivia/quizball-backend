import { describe, expect, it } from 'vitest';
import { indexDay, orderClues } from '../../src/modules/pistas/pistas.content.js';
import { addDays, CLUE_ORDER_FROM } from '../../src/modules/pistas/pistas.days.js';
import { toDayRow } from '../../src/modules/pistas/pistas.seed.js';
import type { ClueKind } from '../../src/modules/pistas/pistas.types.js';
import { makeDay } from './fixtures.js';

const clue = (kind: ClueKind, id: string) => ({ kind, id });
const ids = (clues: Array<{ id: string }>) => clues.map((c) => c.id);
/** The content pipeline's order: profile chips first, then facts hardest-to-easiest. */
const STORED = [
  clue('confed', 'confed'), clue('position', 'position'), clue('foot', 'foot'), clue('decade', 'decade'),
  clue('fact', 'f1'), clue('fact', 'f2'), clue('fact', 'f3'), clue('fact', 'f4'), clue('fact', 'f5'), clue('fact', 'f6'),
];

describe('pistas clue order', () => {
  it('opens on a specific fact, puts each broad chip after a fact and keeps the easiest facts last', () => {
    expect(ids(orderClues(STORED))).toEqual(['f1', 'position', 'f2', 'decade', 'f3', 'confed', 'f4', 'foot', 'f5', 'f6']);
  });

  it('is idempotent and keeps every clue exactly once', () => {
    const once = orderClues(STORED);
    expect(orderClues(once)).toEqual(once);
    expect(new Set(once)).toEqual(new Set(STORED));
  });

  it('copes with rounds that have few or no facts', () => {
    const chips = STORED.slice(0, 4);
    expect(ids(orderClues(chips))).toEqual(ids(chips));
    expect(ids(orderClues([...chips, clue('fact', 'f1')]))).toEqual(['f1', 'position', 'decade', 'confed', 'foot']);
    expect(ids(orderClues([...chips, clue('fact', 'f1'), clue('fact', 'f2'), clue('fact', 'f3')])))
      .toEqual(['f1', 'position', 'decade', 'confed', 'foot', 'f2', 'f3']);
    expect(ids(orderClues(STORED.slice(4)))).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
  });

  it('serves the new order only from CLUE_ORDER_FROM; earlier days and the content version are untouched', () => {
    const before = makeDay(addDays(CLUE_ORDER_FROM, -1));
    const from = makeDay(CLUE_ORDER_FROM);
    const oldDay = indexDay(toDayRow(before))!;
    expect(oldDay.rounds[0].clues.map((c) => c.kind)).toEqual(before.rounds[0].clues.map((c) => c.kind));
    const newDay = indexDay(toDayRow(from))!;
    expect(newDay.contentVersion).toBe(from.contentVersion);
    for (const [r, round] of newDay.rounds.entries()) {
      expect(round.clues[0].kind).toBe('fact');
      expect(round.clues[0]).toEqual(from.rounds[r].clues[4]);
      expect(round.clues.slice(-2)).toEqual(from.rounds[r].clues.slice(-2));
    }
  });
});
