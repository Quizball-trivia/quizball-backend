import { describe, expect, it } from 'vitest';
import { choose, newState, pick, positions, publicState, rebase, result, score } from '../../src/modules/football-race/football-race.rules.js';
import { dayRaceSchema, type DayRace } from '../../src/modules/football-race/football-race.types.js';

// INVENTED nations and numbers (public repo). Y is yours; R1 leads the r* stats; tie = Y and R1 level at the top.
const L = (en: string) => ({ en, es: en, ka: en, tr: en });
const metric = (id: string) => ({ id, family: 'results', dir: 'high' as const, unwanted: false, decimals: 0, kind: 'count' as const, label: L(id), keywords: '' });
const V = (y: number, r1: number) => ({ Y: y, R1: r1, R2: 2, R3: 1 });
const stats = [
  ...['y1', 'y2', 'y3', 'y4', 'y5'].map((m) => ({ id: `TT.all:${m}`, scope: 'TT.all', metric: m, values: V(9, 3), details: { Y: L(`Y ${m}`) } })),
  ...['r1', 'r2', 'r3'].map((m) => ({ id: `TT.all:${m}`, scope: 'TT.all', metric: m, values: V(3, 9) })),
  { id: 'TT.all:tie', scope: 'TT.all', metric: 'tie', values: V(9, 9) },
];
const DAY: DayRace = dayRaceSchema.parse({
  racers: ['Y', 'R1', 'R2', 'R3'],
  data: {
    release: 'test-1', cutoff: '2031-01-01', source: L('Invented'), tournament: { id: 'TT', label: L('Invented Cup') },
    nations: ['Y', 'R1', 'R2', 'R3'].map((id, tier) => ({ id, code: `${id}XX`.slice(0, 3), flag: 'xx', name: L(id), tier })),
    scopes: [{ id: 'TT.all', label: L('All-time') }], families: [{ id: 'results', label: L('Results') }],
    metrics: stats.map((s) => metric(s.metric)), stats,
  },
});
const play = (...ids: string[]) => ids.reduce((s, id) => pick(s, DAY, `TT.all:${id}`), newState());

describe('daily race rules', () => {
  it('starts the rivals two ahead and wins on the fifth right pick, score 995', () => {
    expect(positions(newState())).toEqual([0, 2, 2, 2]);
    const s = play('y1', 'y2', 'y3', 'y4', 'y5');
    expect(result(s)).toBe('won');
    expect(s.done).toBe(true);
    expect(score(s)).toBe(995);
    expect(() => pick(s, DAY, 'TT.all:r1')).toThrow();
  });
  it('loses when three wrong picks feed one rival; a loss ranks by distance, then fewer picks', () => {
    const s = play('y1', 'r1', 'r2', 'r3');
    expect(result(s)).toBe('lost');
    expect(score(s)).toBe(1 * 100 + 99 - 4);
    expect(score(play('y1', 'y2', 'r1', 'r2', 'r3'))).toBeGreaterThan(score(s));
    // Any win beats any loss.
    expect(score(play('y1', 'y2', 'y3', 'y4', 'r1', 'r2', 'y5'))).toBeGreaterThan(score(play('y1', 'y2', 'y3', 'y4', 'r1', 'r2', 'r3')));
  });
  it('a tie that takes you and a rival to the line together is your win', () => {
    const s = play('y1', 'y2', 'y3', 'y4', 'r1', 'r2', 'tie');
    expect(positions(s).slice(0, 2)).toEqual([5, 5]);
    expect(result(s)).toBe('won');
  });
  it('refuses a stat twice or one that is not in the day', () => {
    const s = play('y1');
    expect(() => pick(s, DAY, 'TT.all:y1')).toThrow(/stat_used/);
    expect(() => pick(s, DAY, 'TT.all:nope')).toThrow(/unknown_stat/);
  });
  it('shows values only for the stats played', () => {
    const view = publicState(play('y1'), '2031-01-02', DAY, { ranked: true });
    expect(view.results).toHaveLength(1);
    expect(view.results[0]).toMatchObject({ stat: 'TT.all:y1', values: [9, 3, 2, 1], leaders: [0] });
    expect(view.results[0].details[0]).toEqual(L('Y y1'));
    const { results: _r, ...rest } = view;
    expect(JSON.stringify(rest)).not.toMatch(/"values"/);
    expect(view.stats.map((s) => s.id)).toContain('TT.all:y2');
  });
  it('the day schema refuses a stat that splits nobody, so a run can always finish', () => {
    const level = { id: 'TT.all:level', scope: 'TT.all', metric: 'level', values: { Y: 4, R1: 4, R2: 4, R3: 4 } };
    const broken = { racers: ['Y', 'R1', 'R2', 'R3'], data: { ...DAY.data, metrics: [...DAY.data.metrics, metric('level')], stats: [...stats, level] } };
    const parsed = dayRaceSchema.safeParse(broken);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/does not split/);
  });
  it('a stat naming an unknown metric is a schema error, not a crash', () => {
    const broken = { racers: ['Y', 'R1', 'R2', 'R3'], data: { ...DAY.data, stats: [...stats, { id: 'TT.all:ghost', scope: 'TT.all', metric: 'ghost', values: V(9, 3) }] } };
    let parsed: ReturnType<typeof dayRaceSchema.safeParse> | null = null;
    expect(() => { parsed = dayRaceSchema.safeParse(broken); }).not.toThrow();
    expect(parsed!.success).toBe(false);
  });
  it('a correction restarts an unfinished run on the corrected race', () => {
    expect(rebase(play('y1', 'r1'))).toEqual(newState());
  });
  it('the day schema refuses a day whose racers lack a value', () => {
    const broken = { racers: ['Y', 'R1', 'R2', 'R3'], data: { ...DAY.data, stats: [{ ...stats[0], values: { Y: 1, R1: 2, R2: 3 } }] } };
    expect(dayRaceSchema.safeParse(broken).success).toBe(false);
  });
  it('racing as a chosen rival: its stats move you, the rest keep the day order behind you', () => {
    const s = ['r1', 'r2', 'r3', 'tie'].reduce((st, id) => pick(st, DAY, `TT.all:${id}`), choose(newState(), DAY, 'R1'));
    // R1 leads r1..r3 alone; the tie is shared with Y, now seat 1.
    expect(positions(s)).toEqual([4, 3, 2, 2]);
    expect(s.res[0]).toMatchObject({ values: [9, 3, 2, 1], leaders: [0] });
    // Y's stat now moves a rival.
    expect(positions(pick(s, DAY, 'TT.all:y1'))).toEqual([4, 4, 2, 2]);
    const view = publicState(s, '2031-01-02', DAY, { ranked: true });
    expect(view.nation).toBe('R1');
    expect(view.racers.map((r) => r.id)).toEqual(['R1', 'Y', 'R2', 'R3']);
    expect(view.rivalTarget).toBe(3);
  });
  it('the choice is open until the first pick, and a pick without one races as the day\'s first nation', () => {
    expect(publicState(newState(), '2031-01-02', DAY, { ranked: true }).nation).toBeNull();
    const changed = choose(choose(newState(), DAY, 'R2'), DAY, 'R3');
    expect(changed.nation).toBe('R3');
    expect(() => choose(newState(), DAY, 'NOPE')).toThrow(/unknown_nation/);
    const unchosen = pick(newState(), DAY, 'TT.all:y1');
    expect(unchosen.nation).toBe('Y');
    expect(unchosen.res[0].leaders).toEqual([0]);
    expect(() => choose(unchosen, DAY, 'R1')).toThrow(/nation_locked/);
    expect(() => choose(play('y1', 'y2', 'y3', 'y4', 'y5'), DAY, 'R1')).toThrow(/nation_locked/);
  });
  it('a nation a correction took out of the day falls back to the day order; the rebase clears the choice', () => {
    const view = publicState({ ...newState(), nation: 'GONE' }, '2031-01-02', DAY, { ranked: true });
    expect(view.racers.map((r) => r.id)).toEqual(['Y', 'R1', 'R2', 'R3']);
    expect(view.nation).toBeNull();
    const played = publicState({ ...play('y1'), nation: 'GONE' }, '2031-01-02', DAY, { ranked: true });
    expect(played.nation).toBe('Y');
    expect(rebase(choose(newState(), DAY, 'R1'))).toEqual(newState());
  });
});
