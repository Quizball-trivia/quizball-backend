import { rejected } from '../daily/daily.errors.js';
import { compare } from '../room/games/football-race/football-race.rules.js';
import { MAX_PICKS, RIVAL_HEAD_START, SOLO_TARGET } from './football-race.constants.js';
import type { DayRace, PickResult, PublicRunState, RunState } from './football-race.types.js';

/**
 * The daily race, pure: your nation (racer 0) against three; everyone races to SOLO_TARGET, the rivals start
 * RIVAL_HEAD_START ahead. Each pick moves the nation(s) that lead the stat. You win on reaching the line (a tie that
 * takes you there with a rival is yours: it was your pick); you lose when a rival gets there first, or when the day has
 * no stat left. The score orders the board: a win beats any loss, fewer picks first; a loss ranks by how far you got.
 */
export const newState = (): RunState => ({ v: 1, res: [], done: false });
const pack = (s: RunState): RunState => ({ v: 1, res: s.res, done: s.done });

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
  const cmp = stat && metric ? compare(stat, metric, day.racers) : null;
  if (!cmp) throw rejected('unknown_stat');
  const res: PickResult[] = [...s.res, { stat: statId, values: cmp.values, leaders: cmp.leaders }];
  const next: RunState = { v: 1, res, done: false };
  const metricOf = new Map(day.data.metrics.map((m) => [m.id, m]));
  const left = day.data.stats.filter((x) => !res.some((r) => r.stat === x.id) && compare(x, metricOf.get(x.metric)!, day.racers)).length;
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
  return {
    day: dayId,
    release: d?.release ?? '',
    cutoff: d?.cutoff ?? '',
    source: d?.source ?? { en: '', es: '' },
    tournament: d ? { id: d.tournament.id, label: d.tournament.label } : { id: '', label: { en: '', es: '' } },
    racers: (day?.racers ?? []).map((id) => { const n = nationOf.get(id)!; return { id, code: n.code, flag: n.flag, name: n.name }; }),
    target: SOLO_TARGET,
    positions: positions(s),
    eras: (d?.scopes ?? []).map((x) => ({ id: x.id, label: x.label })),
    families: (d?.families ?? []).map((f) => ({ id: f.id, label: f.label })),
    metrics: (d?.metrics ?? []).map((m) => ({ id: m.id, family: m.family, unwanted: m.unwanted, dir: m.dir, decimals: m.decimals, kind: m.kind, label: m.label, keywords: m.keywords })),
    stats: (d?.stats ?? []).map((x) => ({ id: x.id, scope: x.scope, metric: x.metric, family: metricOf.get(x.metric)?.family ?? '', unwanted: metricOf.get(x.metric)?.unwanted ?? false })),
    results: s.res.map((r) => ({ ...r, details: (day?.racers ?? []).map((id) => statOf.get(r.stat)?.details?.[id] ?? null) })),
    done: s.done,
    result: result(s),
    picks: s.res.length,
    score: score(s),
    ranked: extra.ranked,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
