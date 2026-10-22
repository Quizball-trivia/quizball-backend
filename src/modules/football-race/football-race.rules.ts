import { rejected } from '../daily/daily.errors.js';
import { compare } from '../room/games/football-race/football-race.rules.js';
import { withRussian, withRussianKeywords } from '../room/games/football-race/football-race.russian.js';
import { MAX_PICKS, RIVAL_HEAD_START, SOLO_TARGET } from './football-race.constants.js';
import type { DayRace, PickResult, PublicRunState, RunState } from './football-race.types.js';

/**
 * The daily race, pure: your nation against the day's other three; everyone races to SOLO_TARGET, the rivals start
 * RIVAL_HEAD_START ahead. You choose your nation among the day's four before the first pick (without a choice it is
 * the day's first racer); seat 0 is always yours, the rivals keep the day's order. Each pick moves the nation(s) that lead the stat. You win on reaching the line (a tie that
 * takes you there with a rival is yours: it was your pick); you lose when a rival gets there first, or when the day has
 * no stat left. The score orders the board: a win beats any loss, fewer picks first; a loss ranks by how far you got.
 */
export const newState = (): RunState => ({ v: 1, res: [], done: false });
const pack = (s: RunState): RunState => ({ v: 1, res: s.res, done: s.done, ...(s.nation !== undefined ? { nation: s.nation } : {}) });

/** The day's racers by seat: the chosen nation first. A nation a correction took out of the day falls back to the day's order. */
export function seats(s: RunState, day: DayRace): string[] {
  const mine = s.nation;
  return mine && day.racers.includes(mine) ? [mine, ...day.racers.filter((id) => id !== mine)] : day.racers;
}

/** Racing as one of the day's four; open until the first pick (changing your mind before it is fine). */
export function choose(s: RunState, day: DayRace, nation: string): RunState {
  if (s.done || s.res.length > 0) throw rejected('nation_locked');
  if (!day.racers.includes(nation)) throw rejected('unknown_nation');
  return pack({ ...s, nation });
}

export function positions(s: RunState): number[] {
  const p = [0, RIVAL_HEAD_START, RIVAL_HEAD_START, RIVAL_HEAD_START];
  for (const r of s.res) for (const seat of r.leaders) p[seat] += 1;
  return p;
}

export function result(s: RunState): 'won' | 'lost' | null {
  const p = positions(s);
  const last = s.res.at(-1);
  if (p[0] >= SOLO_TARGET && last?.leaders.includes(0)) return 'won';
  if (p.some((x, i) => i > 0 && x >= SOLO_TARGET)) return 'lost';
  return s.done ? 'lost' : null;
}

export function pick(s: RunState, day: DayRace, statId: string): RunState {
  if (s.done) throw rejected('run_done');
  if (s.res.some((r) => r.stat === statId)) throw rejected('stat_used');
  const stat = day.data.stats.find((x) => x.id === statId);
  const metric = stat && day.data.metrics.find((m) => m.id === stat.metric);
  const racers = seats(s, day);
  const cmp = stat && metric ? compare(stat, metric, racers) : null;
  if (!cmp) throw rejected('unknown_stat');
  const res: PickResult[] = [...s.res, { stat: statId, values: cmp.values, leaders: cmp.leaders }];
  // A pick without a choice fixes the day's first racer, so a later choice can never re-seat the picks already judged.
  const next: RunState = { v: 1, res, done: false, nation: racers[0] };
  const metricOf = new Map(day.data.metrics.map((m) => [m.id, m]));
  const left = day.data.stats.filter((x) => !res.some((r) => r.stat === x.id) && compare(x, metricOf.get(x.metric)!, racers)).length;
  return pack({ ...next, done: result(next) !== null || left === 0 || res.length >= MAX_PICKS });
}

/**
 * A correction moved an unfinished run onto new content (unranked by then): it starts the corrected race again. Picks
 * judged on the old race could name stats the new one no longer has, and leave a run that can never finish.
 */
export const rebase = (_s: RunState): RunState => newState();

/** Won: 1000 − picks (995 = perfect). Lost: how far you got × 100 + (99 − picks), so fewer picks breaks a tie. */
export function score(s: RunState): number {
  const picks = s.res.length;
  if (result(s) === 'won') return 1000 - picks;
  return positions(s)[0] * 100 + Math.max(0, 99 - picks);
}

export function publicState(s: RunState, dayId: string, day: DayRace | null, extra: { ranked: boolean; rank?: number }): PublicRunState {
  const d = day?.data;
  const metricOf = new Map((d?.metrics ?? []).map((m) => [m.id, m]));
  const nationOf = new Map((d?.nations ?? []).map((n) => [n.id, n]));
  const statOf = new Map((d?.stats ?? []).map((x) => [x.id, x]));
  const racers = day ? seats(s, day) : [];
  return {
    day: dayId,
    release: d?.release ?? '',
    cutoff: d?.cutoff ?? '',
    source: d ? withRussian(d.source) : { en: '', es: '' },
    tournament: d ? { id: d.tournament.id, label: withRussian(d.tournament.label) } : { id: '', label: { en: '', es: '' } },
    racers: racers.map((id) => { const n = nationOf.get(id)!; return { id, code: n.code, flag: n.flag, name: withRussian(n.name) }; }),
    // The nation actually in seat 0: a stored one a correction took out of the day no longer is.
    nation: s.nation !== undefined && racers[0] === s.nation ? s.nation : s.res.length > 0 ? racers[0] ?? null : null,
    target: SOLO_TARGET,
    rivalTarget: SOLO_TARGET - RIVAL_HEAD_START,
    positions: positions(s),
    eras: (d?.scopes ?? []).map((x) => ({ id: x.id, label: withRussian(x.label) })),
    families: (d?.families ?? []).map((f) => ({ id: f.id, label: withRussian(f.label) })),
    metrics: (d?.metrics ?? []).map((m) => ({ id: m.id, family: m.family, unwanted: m.unwanted, dir: m.dir, decimals: m.decimals, kind: m.kind, label: withRussian(m.label), keywords: withRussianKeywords(m.label, withRussianKeywords(m.label, m.keywords), 'pt') })),
    stats: (d?.stats ?? []).map((x) => ({ id: x.id, scope: x.scope, metric: x.metric, family: metricOf.get(x.metric)?.family ?? '', unwanted: metricOf.get(x.metric)?.unwanted ?? false })),
    results: s.res.map((r) => ({ ...r, details: racers.map((id) => { const line = statOf.get(r.stat)?.details?.[id]; return line ? withRussian(line) : null; }) })),
    done: s.done,
    result: result(s),
    picks: s.res.length,
    score: score(s),
    ranked: extra.ranked,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
