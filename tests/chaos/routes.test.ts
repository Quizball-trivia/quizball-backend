import { describe, expect, it } from 'vitest';
import { CHAOS_ROUTES, SPEND_ROUTES } from '../../scripts/chaos/routes.js';

const DAILY_TYPES = [
  'moneyDrop',
  'trueFalse',
  'clues',
  'countdown',
  'putInOrder',
  'imposter',
  'careerPath',
  'highLow',
  'footballLogic',
];

describe('chaos route coverage', () => {
  it('drives a session and completion for every daily challenge type', () => {
    const paths = new Set([...CHAOS_ROUTES, ...SPEND_ROUTES].map((route) => route.path));

    for (const type of DAILY_TYPES) {
      expect(paths).toContain(`/api/v1/daily-challenges/${type}/session`);
      expect(paths).toContain(`/api/v1/daily-challenges/${type}/complete`);
    }
  });

  it('includes safe onboarding and notification mutations', () => {
    const names = new Set(CHAOS_ROUTES.map((route) => route.name));

    expect(names).toContain('users.me.complete-onboarding');
    expect(names).toContain('notifications.read-all');
  });
});
