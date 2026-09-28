import { BadRequestError } from '../../core/errors.js';
import { PERFECT_BONUS } from './buscaminas.constants.js';
import { contentChanged } from './buscaminas.errors.js';
import type { IndexedRound } from './buscaminas.content.js';
import type { PublicRunState, RoundResult, RunState } from './buscaminas.types.js';

export function newState(): RunState {
  return { v: 1, r: 0, p: [], m: null, s: null, res: [], done: false };
}

/** Only the known fields: rows written by the previous (token) design carry extra ones. */
const pack = (s: RunState): RunState => ({ v: 1, r: s.r, p: s.p, m: s.m, s: s.s, res: s.res, done: s.done });

const found = (s: RunState): number => s.p.length - (s.m ? 1 : 0);

const rejected = (reason: string): BadRequestError => new BadRequestError(reason, { reason });

export function tap(s: RunState, round: IndexedRound, cardId: string): { state: RunState; ok: boolean } {
  if (s.done) throw rejected('run_done');
  if (s.s) throw rejected('round_settled');
  // The run's content version matched, so a card the round lacks means the page shows different content.
  if (!round.cardIds.has(cardId)) throw contentChanged();
  if (s.p.includes(cardId)) throw rejected('already_picked');
  const picked = [...s.p, cardId];
  if (!round.okIds.has(cardId)) {
    return { ok: false, state: pack({ ...s, p: picked, m: cardId, s: { outcome: 'mine', found: found(s), points: 0 } }) };
  }
  const next = pack({ ...s, p: picked });
  const hits = found(next);
  if (hits >= round.okIds.size) next.s = { outcome: 'perfect', found: hits, points: hits + PERFECT_BONUS };
  return { ok: true, state: next };
}

export function bank(s: RunState): RunState {
  if (s.done) throw rejected('run_done');
  if (s.s) throw rejected('round_settled');
  const hits = found(s);
  if (hits < 1) throw rejected('nothing_to_bank');
  return pack({ ...s, s: { outcome: 'banked', found: hits, points: hits } });
}

export function next(s: RunState, totalRounds: number): RunState {
  if (s.done) throw rejected('run_done');
  if (!s.s) throw rejected('round_not_settled');
  const res = [...s.res, s.s];
  if (res.length >= totalRounds) return pack({ ...s, res, s: null, done: true });
  return pack({ ...s, r: s.r + 1, p: [], m: null, s: null, res });
}

export const score = (s: RunState): number => s.res.reduce((sum, r) => sum + r.points, 0) + (s.s?.points ?? 0);

export const perfects = (results: readonly RoundResult[]): number => results.filter((r) => r.outcome === 'perfect').length;

/** Answers of the current round appear only once it is settled, and only when `reveal` allows (archive days only, never a live day). */
export function publicState(s: RunState, day: string, round: IndexedRound | null, extra: { ranked: boolean; reveal: boolean; rank?: number }): PublicRunState {
  return {
    day,
    round: s.r,
    picked: [...s.p],
    found: found(s),
    mine: s.m,
    settled: s.s ? { ...s.s, reveal: extra.reveal && round ? { ok: [...round.ok], mines: [...round.mines] } : null } : null,
    results: [...s.res],
    done: s.done,
    score: score(s),
    ranked: extra.ranked,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
