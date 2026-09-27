import { BadRequestError } from '../../core/errors.js';
import { PERFECT_BONUS } from './buscaminas.constants.js';
import { contentChanged } from './buscaminas.errors.js';
import type { IndexedRound } from './buscaminas.content.js';
import type { PublicRunState, RoundResult, RunPayload } from './buscaminas.types.js';

export function newPayload(rid: string, day: string, cv: number, userId: string | null, sv = 0): RunPayload {
  return { v: 1, rid, d: day, cv, u: userId, r: 0, p: [], m: null, s: null, res: [], done: false, sv };
}

const found = (p: RunPayload): number => p.p.length - (p.m ? 1 : 0);

const rejected = (reason: string): BadRequestError => new BadRequestError(reason, { reason });

export function tap(p: RunPayload, round: IndexedRound, cardId: string): { payload: RunPayload; ok: boolean } {
  if (p.done) throw rejected('run_done');
  if (p.s) throw rejected('round_settled');
  // The token's content version matched, so a card the round lacks means the page shows different content.
  if (!round.cardIds.has(cardId)) throw contentChanged();
  if (p.p.includes(cardId)) throw rejected('already_picked');
  const picked = [...p.p, cardId];
  if (!round.okIds.has(cardId)) {
    return { ok: false, payload: { ...p, p: picked, m: cardId, s: { outcome: 'mine', found: found(p), points: 0 } } };
  }
  const next = { ...p, p: picked };
  const hits = found(next);
  if (hits >= round.okIds.size) next.s = { outcome: 'perfect', found: hits, points: hits + PERFECT_BONUS };
  return { ok: true, payload: next };
}

export function bank(p: RunPayload): RunPayload {
  if (p.done) throw rejected('run_done');
  if (p.s) throw rejected('round_settled');
  const hits = found(p);
  if (hits < 1) throw rejected('nothing_to_bank');
  return { ...p, s: { outcome: 'banked', found: hits, points: hits } };
}

export function next(p: RunPayload, totalRounds: number): RunPayload {
  if (p.done) throw rejected('run_done');
  if (!p.s) throw rejected('round_not_settled');
  const res = [...p.res, p.s];
  if (res.length >= totalRounds) return { ...p, res, s: null, done: true };
  return { ...p, r: p.r + 1, p: [], m: null, s: null, res };
}

export const score = (p: RunPayload): number => p.res.reduce((sum, r) => sum + r.points, 0) + (p.s?.points ?? 0);

export const perfects = (results: readonly RoundResult[]): number => results.filter((r) => r.outcome === 'perfect').length;

/** Answers of the current round appear only once it is settled, and only when `reveal` allows (archive days only, never a live day). */
export function publicState(p: RunPayload, round: IndexedRound | null, extra: { ranked: boolean; reveal: boolean; rank?: number }): PublicRunState {
  return {
    day: p.d,
    round: p.r,
    picked: [...p.p],
    found: found(p),
    mine: p.m,
    settled: p.s ? { ...p.s, reveal: extra.reveal && round ? { ok: [...round.ok], mines: [...round.mines] } : null } : null,
    results: [...p.res],
    done: p.done,
    score: score(p),
    ranked: extra.ranked,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
