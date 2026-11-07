import { describe, expect, it } from 'vitest';
import { academyMove, completionOf, finishMove, fromScore, maskId, newRunState, pickMove, publicRun, rankScore, recordStat, respinMove, spinMove, undoMove, type RunContext, type RunState } from '../../src/modules/draft/draft.run.js';
import { inventedUniverse } from './draft.fixture.js';
import type { Variant } from '../../src/modules/draft/draft.rules.js';

const u = inventedUniverse();
const ctx = (variant: Variant = 'classic', mode: RunContext['mode'] = 'daily', seed = 'seed-a'): RunContext => ({ u, mode, setup: { release: 'r', leagueId: 'sol', era: 'all', formation: '4-3-3', variant, seed } });

function complete(c: RunContext, s0: RunState = newRunState()): RunState {
  let s = s0;
  for (let i = 0; i < 40 && s.phase === 'picking'; i++) {
    if (s.armed) { s = spinMove(c, s); continue; }
    const view = publicRun(c, s);
    const open = view.spin!.players.find((p) => { try { pickMove(c, s, p.id); return true; } catch { return false; } });
    s = open ? pickMove(c, s, open.id) : academyMove(c, s, ['gk', 'lb', 'lcb', 'rcb', 'rb', 'lcm', 'cm', 'rcm', 'lw', 'st', 'rw'].find((_, k) => !s.picks[k])!);
  }
  return s;
}

describe('a run', () => {
  it('shows no squad until Spin and refuses a signing before it', () => {
    const c = ctx();
    const s = newRunState();
    expect(publicRun(c, s).spin).toBeNull();
    expect(() => pickMove(c, s, 'x')).toThrow('spin_first');
  });
  it('never puts the seed or the deal in what a player sees', () => {
    const c = ctx('budget');
    const text = JSON.stringify(publicRun(c, finishMove(c, complete(c))));
    expect(text).not.toContain('seed-a');
    expect(text).not.toContain('"deal"');
    expect(text).not.toContain('usedClubs');
  });
  it('hides ratings, stats, prices and real ids in Ball Knowledge until the result', () => {
    const c = ctx('knowledge');
    const s = spinMove(c, newRunState());
    const view = publicRun(c, s);
    expect(view.spin!.players.every((p) => p.rating === 0 && p.goals === 0 && p.assists === null && p.price === undefined)).toBe(true);
    expect(view.spin!.players.every((p) => /^[0-9a-f]{16}$/.test(p.id))).toBe(true);
    const names = view.spin!.players.map((p) => p.name);
    expect(names).toEqual(names.slice().sort((a, b) => a.localeCompare(b)));
    const ready = complete(c, s);
    expect(publicRun(c, ready).prediction).toBeNull();
    expect(JSON.stringify(publicRun(c, ready).picks)).not.toMatch(/"rating":[1-9]/);
    const done = finishMove(c, ready);
    expect(publicRun(c, done).picks.some((p) => (p?.player.rating ?? 0) > 0)).toBe(true);
    expect(publicRun(c, done).prediction).not.toBeNull();
  });
  it('undo only while the next squad is hidden, and it restores the squad', () => {
    const c = ctx();
    const open = spinMove(c, newRunState());
    const id = publicRun(c, open).spin!.players.find((p) => p.pos === 'FWD')!.id;
    const signed = pickMove(c, open, id);
    expect(publicRun(c, signed).spin).toBeNull();
    const back = undoMove(signed);
    expect(publicRun(c, back).spin!.id).toBe(publicRun(c, open).spin!.id);
    expect(back.picks.every((p) => !p)).toBe(true);
    expect(() => undoMove(back)).toThrow('nothing_to_undo');
    expect(() => undoMove(spinMove(c, signed))).toThrow('nothing_to_undo');
  });
  it('a re-spin clears undo, and there are two free ones on the daily', () => {
    const c = ctx();
    let s = spinMove(c, newRunState());
    s = respinMove(c, s, 'club').state;
    s = respinMove(c, s, 'season').state;
    expect(s.undo).toBeNull();
    expect(() => respinMove(c, s, 'club')).toThrow('no_respins');
  });
  it('free play charges coins after the free ones, and refuses when short', () => {
    const base = ctx('classic', 'free');
    let s = spinMove(base, newRunState());
    s = respinMove({ ...base, coins: 100 }, s, 'club').state;
    s = respinMove({ ...base, coins: 100 }, s, 'club').state;
    const paid = respinMove({ ...base, coins: 100 }, s, 'club');
    expect(paid.coinsSpent).toBe(25);
    const short = respinMove({ ...base, coins: 10 }, paid.state, 'club');
    expect(short.coinsSpent).toBe(0);
    expect(short.state.notice).toBe('no_coins');
  });
  it('the same setup gives the same deal, another version another one', () => {
    const a = ctx('classic', 'daily', 'same'), b = ctx('classic', 'daily', 'same'), other = ctx('classic', 'daily', 'other');
    const first = (c: RunContext) => publicRun(c, spinMove(c, newRunState())).spin!.id;
    expect(first(a)).toBe(first(b));
    expect(first(a)).not.toBe(first(other));
  });
  it('finishing needs a full XI, and finishing twice changes nothing', () => {
    const c = ctx();
    expect(() => finishMove(c, newRunState())).toThrow('draft_not_finished');
    const done = finishMove(c, complete(c));
    expect(finishMove(c, done)).toBe(done);
    expect(done.result!.season.table.length).toBe(8);
  });
  it('the board number keeps the order and the record survives', () => {
    const s = { points: 80, gf: 70, ga: 30, w: 25, d: 5, l: 8 };
    expect(rankScore({ ...s, points: 81 })).toBeGreaterThan(rankScore(s));
    expect(rankScore({ ...s, gf: 71 })).toBeGreaterThan(rankScore(s));
    expect(fromScore(rankScore(s), recordStat(s))).toMatchObject({ points: 80, gd: 40, gf: 70, w: 25, d: 5, l: 8 });
  });
  it('a budget run cannot overspend and its picks carry the price', () => {
    const c = ctx('budget');
    const s = complete(c);
    expect(s.phase).toBe('ready');
    expect(completionOf(s)).toBeNull();
    expect(publicRun(c, s).spent).toBeLessThanOrEqual(300);
    expect(s.picks.filter((p) => p && !p.academy).every((p) => (p!.price ?? 0) > 0)).toBe(true);
  });
  it('mask ids are stable and do not show the real id', () => {
    expect(maskId('s', 'a')).toBe(maskId('s', 'a'));
    expect(maskId('s', 'a')).not.toBe(maskId('s2', 'a'));
    expect(maskId('s', 'a')).not.toContain('a-');
  });
});
