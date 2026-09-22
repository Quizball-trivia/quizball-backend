import { describe, expect, it } from 'vitest';
import {
  footballGridSearchStartSchema,
  footballGridPracticeBotStartSchema,
  footballGridSubmitAnswerSchema,
} from '../../src/realtime/schemas/football-grid.schemas.js';

const command = { matchId: '00000000-0000-4000-8000-000000000001',
  commandId: '00000000-0000-4000-8000-000000000002', expectedStateVersion: 1, cellIndex: 0, text: 'მბაპე' };

describe('Football Grid four-locale protocol', () => {
  it.each(['en', 'ka', 'es', 'tr'] as const)('preserves %s in searches, guest practice and submissions', (locale) => {
    expect(footballGridSearchStartSchema.parse({ locale }).locale).toBe(locale);
    expect(footballGridPracticeBotStartSchema.parse({ locale }).locale).toBe(locale);
    expect(footballGridSubmitAnswerSchema.parse({ ...command, locale })).toMatchObject({ locale, text: 'მბაპე' });
  });

  it('rejects unsupported locales while retaining the old search default', () => {
    expect(footballGridSearchStartSchema.parse(undefined).locale).toBe('en');
    expect(footballGridSubmitAnswerSchema.safeParse({ ...command, locale: 'de' }).success).toBe(false);
  });
});
