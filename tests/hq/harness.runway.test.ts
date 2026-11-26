import { describe, expect, it } from 'vitest';
import '../setup.js';

const { runwayRow, DAILY_GAMES } = await import('../../src/modules/harness/harness.runway.js');

describe('daily runway', () => {
  const today = '2026-11-26';
  const game = (lastAllowed: string) => ({ key: 'g', label: 'G', lastAllowed });

  it('ends at the last stored day when the calendar is open', () => {
    expect(runwayRow(game('9999-12-31'), '2027-02-22', today)).toMatchObject({ calendarEnds: null, endsOn: '2027-02-22', daysLeft: 88, limitedBy: 'content' });
  });

  it('ends at the fixed calendar end even when more days are stored', () => {
    expect(runwayRow(game('2026-12-09'), '2027-01-31', today)).toMatchObject({ endsOn: '2026-12-09', daysLeft: 13, limitedBy: 'calendar' });
  });

  it('says both when content and calendar end together, and content when content ends first', () => {
    expect(runwayRow(game('2026-12-05'), '2026-12-05', today)).toMatchObject({ daysLeft: 9, limitedBy: 'both' });
    expect(runwayRow(game('2026-12-31'), '2026-12-10', today)).toMatchObject({ endsOn: '2026-12-10', daysLeft: 14, limitedBy: 'content' });
  });

  it('is zero for an empty game or one already past its end', () => {
    expect(runwayRow(game('2026-12-31'), null, today)).toMatchObject({ endsOn: null, daysLeft: 0 });
    expect(runwayRow(game('2026-11-01'), '2026-11-01', today).daysLeft).toBe(0);
  });

  it('lists each daily game once with a plain table name', () => {
    expect(new Set(DAILY_GAMES.map((g) => g.key)).size).toBe(DAILY_GAMES.length);
    for (const g of DAILY_GAMES) expect(g.table).toMatch(/^[a-z0-9_]+_days$/);
  });
});
