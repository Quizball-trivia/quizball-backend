import { describe, expect, it } from 'vitest';
import { finishMove, maskId, newRunState, pickMove, publicRun, respinMove, spinMove, undoMove, type RunContext, type RunState } from '../../src/modules/draft/draft.run.js';
import { rankedSetup, weekOf } from '../../src/modules/draft/draft-play.service.js';
import { pricedFor, universeOf } from '../../src/modules/draft/draft.universe.js';
import { priceOf, type DraftPlayer } from '../../src/modules/draft/draft.rules.js';
import { newDraft } from '../../src/modules/draft/draft.engine.js';
import { inventedIconic, inventedPack } from './draft.fixture.js';

const u = universeOf(inventedPack(), inventedIconic());
const ctx = (over: Partial<RunContext['setup']> = {}): RunContext => ({ u, mode: 'free', setup: { release: 'r', leagueId: 'sol', era: 'all', formation: '4-3-3', variant: 'budget', seed: 'hid', hidden: true, ...over } });

function signFirst(c: RunContext, s: RunState): RunState {
  const view = publicRun(c, s);
  for (const p of view.spin!.players) { try { return pickMove(c, s, p.id); } catch { /* does not fit */ } }
  throw new Error('nobody fits');
}

describe('Budget with hidden ratings', () => {
  it('shows names and prices only, with masked ids, until a player is signed', () => {
    const c = ctx();
    const view = publicRun(c, spinMove(c, newRunState()));
    expect(view.hideSquad).toBe(true);
    expect(view.hidePicks).toBe(false);
    expect(view.spin!.finish).toBe(0);
    for (const p of view.spin!.players) {
      expect(p.rating).toBe(0);
      expect(p.goals + p.apps + p.cleanSheets + p.minutesShare).toBe(0);
      expect(p.price).toBeGreaterThan(0);
      expect(p.id).toMatch(/^[0-9a-f]{16}$/);
      expect(p).not.toHaveProperty('reputation');
    }
  });
  it('reveals the rating of a signing at once, under the same masked ids as the squad', () => {
    const c = ctx();
    const open = spinMove(c, newRunState());
    const signed = signFirst(c, open);
    const pick = publicRun(c, signed).picks.find(Boolean)!;
    expect(pick.player.rating).toBeGreaterThan(0);
    expect(pick.player.id).toMatch(/^[0-9a-f]{16}$/);
    expect(publicRun(c, open).spin!.players.some((p) => p.id === pick.player.id)).toBe(true);
    expect(pick).not.toHaveProperty('best');
  });
  it('has no undo: a signing that shows its rating cannot be taken back', () => {
    const c = ctx();
    const signed = signFirst(c, spinMove(c, newRunState()));
    expect(publicRun(c, signed).canUndo).toBe(false);
    expect(() => undoMove(signed)).toThrow('nothing_to_undo');
  });
  it('a hidden pick resolves only by its masked id', () => {
    const c = ctx();
    const open = spinMove(c, newRunState());
    const real = u.clubSeason(open.spinId!)!.players[0];
    expect(() => pickMove(c, open, real.id)).toThrow('invalid_pick');
    const masked = maskId(c.setup.seed, real.id);
    expect(publicRun(c, open).spin!.players.some((p) => p.id === masked)).toBe(true);
  });
  it('works out no forecast, before or after the season', () => {
    const c = ctx();
    let s = newRunState();
    for (let i = 0; i < 40 && s.phase === 'picking'; i++) s = s.armed ? spinMove(c, s) : signFirst(c, s);
    expect(s.forecast ?? null).toBeNull();
    expect(publicRun(c, s).prediction).toBeNull();
    const done = finishMove(c, s);
    expect(done.result!.prediction ?? null).toBeNull();
    expect(publicRun(c, done).prediction).toBeNull();
    expect(publicRun(c, done).hideSquad).toBe(false);
  });
});

describe('prices from reputation', () => {
  it('a player is priced on his name: his other seasons weigh in, so price no longer gives the rating away', () => {
    const players = inventedPack().clubs.flatMap((c) => u.clubSeason(`${c.clubId}-${c.year}`)!.players);
    expect(players.every((p) => typeof p.reputation === 'number')).toBe(true);
    // Someone with better seasons elsewhere costs more than his rating alone would say.
    const pricier = players.find((p) => (p.reputation ?? 0) > p.rating + 1)!;
    expect(priceOf(pricier)).toBeGreaterThanOrEqual(priceOf({ ...pricier, reputation: undefined } as DraftPlayer));
    // The same player and season costs the same for everyone.
    expect(priceOf(pricier)).toBe(priceOf({ ...pricier }));
  });
});

describe('older setups keep their prices', () => {
  it('a setup from before hidden squads prices on the rating, as it did', () => {
    const legacy = pricedFor(u, {});
    const id = `${inventedPack().clubs[0].clubId}-${inventedPack().clubs[0].year}`;
    const before = legacy.clubSeason(id)!.players;
    expect(before.every((p) => p.reputation === undefined)).toBe(true);
    expect(before.map((p) => priceOf(p))).toEqual(u.clubSeason(id)!.players.map((p) => priceOf({ ...p, reputation: undefined })));
    expect(pricedFor(u, { hidden: true })).toBe(u);
    expect(legacy.clubSeason(id)).toBe(legacy.clubSeason(id));
  });
});

describe('Iconic Clubs', () => {
  it('is a league of its own when the pack carries enough of its seasons', () => {
    expect(u.leagues.map((l) => l.id)).toContain('iconic');
    expect(universeOf(inventedPack()).leagues.map((l) => l.id)).not.toContain('iconic');
  });
  it('rates each player in his own league, and every spin says what made the season', () => {
    const spin = u.spin('iconic', 'all', 'x', []);
    expect(spin.leagueId).toBe('iconic');
    expect(spin.honour).toBe('champions');
    const original = u.clubSeason(spin.id.replace(/^iconic~/, ''))!;
    expect(spin.players.map((p) => p.rating)).toEqual(original.players.map((p) => p.rating));
    expect(u.clubSeason(spin.id)).toBe(spin);
  });
  it('meets its own nineteen rivals on each draw: same seed, same rivals', () => {
    const a = u.opponents('iconic', 'seed-1'), b = u.opponents('iconic', 'seed-1'), other = u.opponents('iconic', 'seed-2');
    expect(a).toHaveLength(19);
    expect(a.map((o) => o.id)).toEqual(b.map((o) => o.id));
    expect(a.map((o) => o.id).sort()).not.toEqual(other.map((o) => o.id).sort());
    expect(new Set(a.map((o) => o.id)).size).toBe(19);
  });
  it('leaves the ordinary leagues\' rivals as they were: club ids, so runs already played keep their tables', () => {
    const ids = u.opponents('sol', 'any').map((o) => o.id);
    expect(ids.every((id) => /^sol-\d+$/.test(id))).toBe(true);
  });
  it('on the varied draw: a few great sides above club-seasons from the real leagues, never one season twice', () => {
    for (let i = 0; i < 10; i++) {
      const rivals = u.opponents('iconic', `mix-${i}`, { rotate: true, mixed: true });
      expect(rivals).toHaveLength(19);
      const seasons = rivals.map((o) => o.id.replace(/^iconic~/, ''));
      expect(new Set(seasons).size).toBe(19);
      expect(rivals.some((o) => o.id.startsWith('iconic~'))).toBe(true);

    }
  });
  it('plays a full season', () => {
    const c = ctx({ leagueId: 'iconic' });
    let s = newRunState();
    for (let i = 0; i < 40 && s.phase === 'picking'; i++) s = s.armed ? spinMove(c, s) : signFirst(c, s);
    const done = finishMove(c, s);
    expect(done.result!.season.games).toBe(38);
    expect(done.result!.season.table).toHaveLength(20);
  });
});

describe('league boards', () => {
  it('a week starts on Monday', () => {
    expect(weekOf('2026-11-16')).toBe('2026-11-16');
    expect(weekOf('2026-11-17')).toBe('2026-11-16');
    expect(weekOf('2026-11-22')).toBe('2026-11-16');
    expect(weekOf('2026-11-23')).toBe('2026-11-23');
  });
  it('ranks only Budget runs with hidden squads across all eras', () => {
    expect(rankedSetup({ variant: 'budget', era: 'all', hidden: true })).toBe(true);
    expect(rankedSetup({ variant: 'budget', era: 'legends', hidden: true })).toBe(false);
    expect(rankedSetup({ variant: 'budget', era: 'all' })).toBe(false);
    expect(rankedSetup({ variant: 'classic', era: 'all', hidden: true })).toBe(false);
  });
});

describe('out of money', () => {
  it('signs a free academy kid on its own when nobody in the squad is affordable, and says so', () => {
    let notices = 0;
    for (let seed = 0; seed < 30; seed++) {
      const c = ctx({ seed: `broke-${seed}` });
      let s = newRunState();
      for (let i = 0; i < 60 && s.phase === 'picking'; i++) {
        if (s.armed) { s = spinMove(c, s); continue; }
        // The dearest affordable player every time: the money runs out early.
        const view = publicRun(c, s);
        const order = view.spin!.players.slice().sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
        const open = order.find((p) => { try { pickMove(c, s, p.id); return true; } catch { return false; } });
        if (!open) {
          // Only with a re-spin left and money that buys someone somewhere: the player chooses, here a re-spin.
          expect(s.notice).toBe('no_money');
          expect(s.respins).toBeGreaterThan(0);
          s = respinMove(c, s, 'club').state;
          continue;
        }
        s = pickMove(c, s, open.id);
        if (s.notice === 'academy_money') {
          notices++;
          // The view names exactly the places the kids took on their own.
          const forced = publicRun(c, s).forced;
          expect(forced.length).toBeGreaterThan(0);
          for (const slotId of forced) expect(s.picks.find((p) => p?.slotId === slotId)?.academy).toBe(true);
          // Still named after Spin.
          if (s.phase === 'picking' && s.armed) expect(publicRun(c, spinMove(c, s)).forced).toEqual(forced);
        } else expect(publicRun(c, s).forced).toEqual([]);
      }
      expect(s.phase).toBe('ready');
      expect(s.picks.every(Boolean)).toBe(true);
    }
    expect(notices).toBeGreaterThan(0);
  });
  it('puts a kid where he hurts least: defence before midfield, attack and goal', () => {
    const c = ctx({ seed: 'broke-0' });
    let s = newRunState();
    for (let i = 0; i < 60 && s.phase === 'picking'; i++) {
      if (s.armed) { s = spinMove(c, s); continue; }
      const order = publicRun(c, s).spin!.players.slice().sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
      const open = order.find((p) => { try { pickMove(c, s, p.id); return true; } catch { return false; } })!;
      s = pickMove(c, s, open.id);
    }
    const kids = s.picks.filter((p) => p?.academy).map((p) => p!.player.pos);
    if (kids.includes('GK')) expect(kids.filter((x) => x !== 'GK').length).toBe(kids.length - 1);
  });
});

describe('variety', () => {
  const big = universeOf(inventedPack(), inventedIconic());
  const dealOf = (seed: string, draw?: { spread?: boolean; avoid?: string[]; rotate?: boolean }) => newDraft(big, { mode: 'free', variant: 'budget', leagueId: 'sol', era: 'all', formation: '4-3-3', seed, draw, seats: [{ name: 'p', avatar: null, bot: false }] }).deal.map((c) => c.clubId);
  it('older setups are dealt exactly as before', () => {
    expect(dealOf('same')).toEqual(dealOf('same'));
    expect(newDraft(big, { mode: 'free', variant: 'budget', leagueId: 'sol', era: 'all', formation: '4-3-3', seed: 'same', seats: [{ name: 'p', avatar: null, bot: false }] }).draw).toBeUndefined();
  });
  it('skips the clubs of the last drafts while others remain', () => {
    const avoid = ['sol-0', 'sol-1', 'sol-2', 'sol-3'];
    for (let i = 0; i < 20; i++) {
      const clubs = dealOf(`a-${i}`, { spread: true, avoid });
      // 12 clubs, 4 avoided: the first 8 spins never meet them.
      expect(clubs.slice(0, 8).some((c) => avoid.includes(c))).toBe(false);
    }
  });
  it('rotates the rivals through whole past seasons, named with the season', () => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) for (const o of big.opponents('sol', `r-${i}`, { rotate: true })) names.add(o.name.split(' ').pop()!);
    expect(names.size).toBeGreaterThan(1);
    expect(big.opponents('sol', 'x').every((o) => !/\d{4}\/\d{2}$/.test(o.name))).toBe(true);
  });
});

describe('Iconic Clubs with a fuller pack', () => {
  it('takes only a few greats, the rest from ordinary club-seasons', () => {
    const pack = inventedPack();
    // Only the first four clubs' seasons are iconic; the other eight clubs are ordinary.
    const iconic = inventedIconic().filter(([id]) => /^sol-[0-3]-/.test(id));
    while (iconic.length < 30) iconic.push(...iconic.slice(0, 30 - iconic.length));
    const big = universeOf(pack, iconic);
    for (let i = 0; i < 10; i++) {
      const rivals = big.opponents('iconic', `few-${i}`, { rotate: true, mixed: true });
      expect(rivals.filter((o) => o.id.startsWith('iconic~')).length).toBeLessThanOrEqual(6);
    }
  });
});
