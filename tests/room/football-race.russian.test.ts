import { describe, expect, it } from 'vitest';
import { newState, pick, publicState } from '../../src/modules/football-race/football-race.rules.js';
import { dayRaceSchema } from '../../src/modules/football-race/football-race.types.js';
import { startMatch, viewOf } from '../../src/modules/room/games/football-race/football-race.engine.js';
import { l10n, raceTournamentDataSchema } from '../../src/modules/room/games/football-race/football-race.rules.js';
import { russianText, withRussianKeywords } from '../../src/modules/room/games/football-race/football-race.russian.js';

// Real nation, stat and tournament NAMES (the Russian wording is keyed by them); every number is INVENTED (public repo).
const L = (en: string) => ({ en, es: en, ka: en, tr: en });
const NATIONS = ['Brazil', 'Argentina', 'France', 'Germany'];
const metric = (id: string, label: string) => ({ id, family: 'results', dir: 'high' as const, unwanted: false, decimals: 0, kind: 'count' as const, label: L(label), keywords: 'won victories' });
const stats = NATIONS.flatMap((leader, i) => [0, 1, 2].map((k) => ({
  id: `WC.all:m${i}${k}`, scope: 'WC.all', metric: `m${i}${k}`,
  values: Object.fromEntries(NATIONS.map((n) => [n, n === leader ? 50 + k : 10])),
  details: { [leader]: L(`7–1 vs ${NATIONS[(i + 1) % 4]} · 2014`) },
})));
const data = {
  release: 'test-ru', cutoff: '2031-01-01', source: L('Invented'), tournament: { id: 'WC', label: L('World Cup') },
  nations: NATIONS.map((name, tier) => ({ id: name, code: name.slice(0, 3).toUpperCase(), flag: 'xx', name: L(name), tier })),
  scopes: [{ id: 'WC.all', label: L('All-time') }], families: [{ id: 'results', label: L('Results') }],
  metrics: stats.map((s) => metric(s.metric, 'Most wins')), stats,
};

describe('Football Horserace in Russian', () => {
  it('reads Russian from the release first, then from the wording keyed by the English', () => {
    expect(l10n({ en: 'Brazil', es: 'Brasil', ru: 'Бразилия (из релиза)' }, 'ru')).toBe('Бразилия (из релиза)');
    expect(l10n({ en: 'Brazil', es: 'Brasil' }, 'ru')).toBe('Бразилия');
    expect(l10n({ en: 'Brazil', es: 'Brasil' }, 'es')).toBe('Brasil');
  });

  it('rebuilds a match line around the opponent; a player name or an unknown line stays as written', () => {
    expect(russianText('7–0 vs Bosnia and Herzegovina · 2024')).toBe('7–0 — Босния и Герцеговина · 2024');
    expect(russianText('Kylian Mbappé · 2018')).toBe('Kylian Mbappé · 2018');
    expect(russianText('7–0 vs Atlantis · 2024')).toBe('7–0 vs Atlantis · 2024');
    expect(russianText('__proto__')).toBe('__proto__');
    expect(russianText('7–0 vs constructor · 2024')).toBe('7–0 vs constructor · 2024');
    expect(withRussianKeywords(L('toString'), 'x')).toBe('x');
  });

  it('adds Russian search words to a stat it knows, and only then', () => {
    expect(withRussianKeywords(L('Most wins'), 'won')).toMatch(/^won .*побед/);
    expect(withRussianKeywords(L('Invented stat'), 'won')).toBe('won');
  });

  it('a Russian seat of a room sees Russian names, stats and tournament', () => {
    const parsed = raceTournamentDataSchema.parse(data);
    const content = { pack: { release: 'test-ru', tournament: 'WC', seed: 1 }, data: parsed };
    const view = viewOf(startMatch(2, content, 1_000), content, 0, 'ru');
    expect(view.tournament.label).toBe('Чемпионат мира');
    expect(view.eras[0].label).toBe('За всю историю');
    expect(view.metrics[0].label).toBe('Больше всего побед');
    expect(view.metrics[0].keywords).toMatch(/побед/);
    expect(viewOf(startMatch(2, content, 1_000), content, 0, 'en').metrics[0].keywords).toBe('won victories');
  });

  it('the daily state carries Russian next to every label, details included', () => {
    const day = dayRaceSchema.parse({ racers: NATIONS, data });
    const s = pick(newState(), day, 'WC.all:m00');
    const state = publicState(s, '2026-10-16', day, { ranked: false });
    expect(state.tournament.label.ru).toBe('Чемпионат мира');
    expect(state.racers.map((r) => r.name.ru)).toEqual(['Бразилия', 'Аргентина', 'Франция', 'Германия']);
    expect(state.metrics[0].label.ru).toBe('Больше всего побед');
    expect(state.results[0].details[0]?.ru).toBe('7–1 — Аргентина · 2014');
  });
});
