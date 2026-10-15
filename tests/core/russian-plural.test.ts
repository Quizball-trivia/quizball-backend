import { describe, expect, it } from 'vitest';
import { russianPlural } from '../../src/core/i18n.js';

describe('russianPlural', () => {
  const coins = (n: number) => `${n} ${russianPlural(n, 'монета', 'монеты', 'монет')}`;
  it('picks one / few / many, with 11–14 always many, and the sign ignored', () => {
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, -1, -3, -100].map(coins)).toEqual([
      '1 монета', '2 монеты', '4 монеты', '5 монет', '11 монет', '12 монет', '14 монет', '21 монета', '22 монеты', '25 монет',
      '101 монета', '111 монет', '-1 монета', '-3 монеты', '-100 монет',
    ]);
  });
});
