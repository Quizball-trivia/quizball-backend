import { describe, expect, it } from 'vitest';

import '../setup.js';
import { mergeLocalizedAcceptedAnswers } from '../../src/lib/localization.js';

describe('mergeLocalizedAcceptedAnswers', () => {
  it('appends localized display values missing from accepted answers', () => {
    expect(
      mergeLocalizedAcceptedAnswers(
        ['Henrik Larsson', 'Larsson'],
        { en: 'Henrik Larsson', ka: 'ჰენრიკ ლარსონი' }
      )
    ).toEqual(['Henrik Larsson', 'Larsson', 'ჰენრიკ ლარსონი']);
  });

  it('deduplicates case-insensitively and skips blank values', () => {
    expect(
      mergeLocalizedAcceptedAnswers(
        ['Crespo'],
        { en: 'CRESPO', ka: '  ', fr: '' }
      )
    ).toEqual(['Crespo']);
  });

  it('ignores non-object and non-string localized values', () => {
    expect(
      mergeLocalizedAcceptedAnswers(['Veron'], null, undefined, 'plain', ['array'], { en: 42 } as never)
    ).toEqual(['Veron']);
  });

  it('merges values from multiple localized objects', () => {
    expect(
      mergeLocalizedAcceptedAnswers(
        [],
        { en: 'Ronaldo Nazário' },
        { ka: 'რონალდო ნაზარიო' }
      )
    ).toEqual(['Ronaldo Nazário', 'რონალდო ნაზარიო']);
  });
});
