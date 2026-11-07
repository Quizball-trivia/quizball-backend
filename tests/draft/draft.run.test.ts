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
    expect(() => finishMove(c, done)).toThrow('draft_over');
    expect(done.result!.season.table.length).toBe(8);
  });
  it('what you signed never changes what comes next on a daily: the deal stays fixed', () => {
    const c = ctx('classic');
    const open = spinMove(c, newRunState());
    const players = publicRun(c, open).spin!.players;
    const a = pickMove(c, open, players.find((p) => p.pos === 'GK')!.id), b = pickMove(c, open, players.find((p) => p.pos === 'FWD')!.id);
    expect(publicRun(c, spinMove(c, a)).spin!.id).toBe(publicRun(c, spinMove(c, b)).spin!.id);
  });
  it('the reels roll through names in an order that says nothing about strength', () => {
    const names = publicRun(ctx('knowledge'), newRunState()).pool;
    expect(names).toEqual(names.slice().sort((x, y) => x.localeCompare(y)));
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

describe('a tie from the other side', () => {
  it('shows their goals first, their home leg first, and their attack against the other defence', async () => {
    const { tieFor } = await import('../../src/modules/draft/draft-play.service.js');
    const result = { goals: [4, 2], legs: [[3, 1], [1, 1]], penalties: null, winner: 0, battles: [{ key: 'attack', mine: 85, theirs: 70, winner: 0 }, { key: 'midfield', mine: 80, theirs: 75, winner: 0 }, { key: 'defence', mine: 72, theirs: 78, winner: 1 }] };
    const row = { id: 't', a_run: 'a', b_run: 'b', a_user: 'u', a_guest: null, b_user: 'v', b_guest: null, a_name: 'A', b_name: 'B', a_picks: [], b_picks: [], seed: 's', result, formation: '4-3-3', created_at: new Date() };
    const mine = tieFor(row as never, 'a'), theirs = tieFor(row as never, 'b');
    expect(mine.result.legs).toEqual([[3, 1], [1, 1]]);
    expect(theirs.opponent).toBe('A');
    expect(theirs.result.goals).toEqual([2, 4]);
    expect(theirs.result.legs).toEqual([[1, 1], [1, 3]]);
    expect(theirs.result.winner).toBe(1);
    expect(theirs.result.battles[0]).toMatchObject({ key: 'attack', mine: 78, theirs: 72, winner: 0 });
    expect(theirs.result.battles[2]).toMatchObject({ key: 'defence', mine: 70, theirs: 85, winner: 1 });
  });
});
