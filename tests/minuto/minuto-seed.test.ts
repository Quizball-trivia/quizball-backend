import { describe, expect, it } from 'vitest';
import { assertCalendar, checkGoal, movedDailyGoals, overlapping, parseDayFile } from '../../src/modules/minuto/minuto.seed.js';
import { calendar, makeDay, rawDay, rawGoal } from './fixtures.js';

describe('minuto seed', () => {
  it('accepts the full calendar and refuses gaps or a goal on two days (by id or by fingerprint)', () => {
    expect(() => assertCalendar(calendar())).not.toThrow();
    const days = calendar();
    expect(() => assertCalendar(days.slice(1))).toThrow(/expected at least|contiguous/);
    const repeat = calendar();
    repeat[5] = { ...repeat[5], goals: [repeat[2].goals[3], ...repeat[5].goals.slice(1)] };
    expect(() => assertCalendar(repeat)).toThrow(`same goal as ${repeat[2].day} goal 4`);
    const samePrint = calendar();
    samePrint[6] = { ...samePrint[6], goals: [{ ...samePrint[6].goals[0], fingerprint: samePrint[1].goals[0].fingerprint }, ...samePrint[6].goals.slice(1)] };
    expect(() => assertCalendar(samePrint)).toThrow(/same goal/);
  });

  it('refuses a malformed goal without quoting its values (no minute in the message)', () => {
    const raw = rawDay('2026-10-01');
    raw.goals[3] = { ...rawGoal('2026-10-01', 3), minute: { base: 61, added: 7 } } as never;
    let message = '';
    try { parseDayFile('2026-10-01.json', raw); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/goal 4: invalid/);
    expect(message).not.toMatch(/61|67|68/);
    const dup = rawDay('2026-10-01');
    dup.goals[4] = { ...dup.goals[4], id: dup.goals[1].id };
    expect(() => parseDayFile('x.json', dup)).toThrow(/goal 5: duplicate id/);
    expect(() => parseDayFile('x.json', { ...rawDay('2026-10-01'), number: 99 })).toThrow(/number must be/);
  });

  it('refuses any public text that names the minute, and never echoes an unknown key in the message', () => {
    const goal = rawGoal('2026-10-01', 9);
    expect(checkGoal({ ...goal, image: { src: 'minuto/photos/0123456789abcdef.webp', credit: 'Goal at 94\' by X', license: 'CC BY 4.0' } })).toMatchObject({ reason: /image\.credit/ });
    expect(checkGoal({ ...goal, scorer: { ...goal.scorer, name: { ...goal.scorer.name, en: 'Goleador 90+4' } } })).toMatchObject({ reason: /scorer\.name\.en/ });
    expect('reason' in checkGoal(goal)).toBe(false);
    const unknown = checkGoal({ ...goal, 'private-minute-94': true }) as { reason: string };
    expect(unknown.reason).not.toContain('94');
    expect(checkGoal({ ...goal, id: 'final-goal-minute-94' })).toMatchObject({ reason: /id:/ });
    expect(checkGoal({ ...goal, image: { src: 'https://evil.example/goal-94.jpg', credit: 'x', license: 'CC0' } })).toMatchObject({ reason: /image/ });
    const photo = (credit: string, src = 'minuto/photos/0123456789abcdef.webp') => checkGoal({ ...goal, image: { src, credit, license: 'CC BY-SA 4.0' } });
    for (const credit of ['Goal, minute: 94', 'Goal at 94:00', '94', 'X (90 + 4)']) expect(photo(credit)).toMatchObject({ reason: /image\.credit/ });
    expect('reason' in photo('Photo by X, 1994')).toBe(false);
    expect(photo('X', 'club-logos/goal-in-minute-94.webp')).toMatchObject({ reason: /image\.src/ });
    expect(checkGoal({ ...goal, image: { src: 'minuto/photos/0123456789abcdef.webp', credit: 'X', license: 'Getty Images' } })).toMatchObject({ reason: /image\.license/ });
    expect(checkGoal({ ...goal, home: { kind: 'club', crest: 'minuto/photos/0123456789abcdef.webp', name: goal.home.name } })).toMatchObject({ reason: /home/ });
    for (const side of ['home', 'away'] as const) {
      expect(checkGoal({ ...goal, [side]: { kind: 'club', crest: 'club-logos/goal-in-minute-94.webp', name: goal[side].name } })).toMatchObject({ reason: new RegExp(`${side}\\.crest`) });
    }
    expect('reason' in checkGoal({ ...goal, home: { kind: 'club', crest: 'club-logos/fc-schalke-04.webp', name: goal.home.name } })).toBe(false);
    expect(checkGoal({ ...goal, scorer: { ...goal.scorer, photo: 'club-logos/scorer-94.webp' } })).toMatchObject({ reason: /scorer\.photo/ });
  });

  it('a goal published on one day may not move to another (by id or by fingerprint)', () => {
    const days = calendar().slice(0, 3);
    const published = [{ id: days[0].goals[2].id, fingerprint: 'x', day: days[0].day }, { id: 'y', fingerprint: days[1].goals[4].fingerprint, day: days[1].day }];
    expect(movedDailyGoals(days, published)).toEqual([]);
    const swapped = [days[1], days[0], days[2]].map((d, i) => ({ ...d, day: calendar()[i].day }));
    expect(movedDailyGoals(swapped, published).length).toBe(2);
    // Each identity on its own: the day-0 goal's id is home, but its fingerprint was disclosed on day 1.
    expect(movedDailyGoals(days, [...published, { id: 'z', fingerprint: days[0].goals[2].fingerprint, day: days[1].day }])).toEqual([expect.stringMatching(/goal 3/)]);
    // Every origin counts, not only the first one recorded.
    expect(movedDailyGoals(days, [...published, { id: days[0].goals[2].id, fingerprint: 'w', day: days[2].day }]).length).toBe(1);
  });

  it('overlap compares ids and fingerprints separately', () => {
    const day = makeDay('2026-10-01');
    const published = [{ id: day.goals[0].id, fingerprint: 'ffffffffffffffff' }, { id: 'other', fingerprint: day.goals[1].fingerprint }];
    expect(overlapping(day.goals, published)).toEqual([0, 1]);
  });
});
