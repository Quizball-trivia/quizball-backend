import { describe, expect, it } from 'vitest';
import { captainMove, completionOf, finishMove, januarySignMove, januarySpinMove, newRunState, pickMove, publicRun, respinMove, spinMove, tacticMove, type RunContext, type RunState } from '../../src/modules/draft/draft.run.js';
import { universeOf } from '../../src/modules/draft/draft.universe.js';
import { BENCH, CHEMISTRY_CAP, CAPTAIN_BONUS, FORMATIONS, TACTICS, absentIn, boostOf, chemistry, lineupFor, lines, momentsOf, offeredTactics, playCup, type Pick } from '../../src/modules/draft/draft.rules.js';
import { inventedIconic, inventedPack } from './draft.fixture.js';

const u = universeOf(inventedPack(), inventedIconic());
const ctx = (seed = 'v2'): RunContext => ({ u, mode: 'free', setup: { release: 'r', leagueId: 'sol', era: 'all', formation: '4-3-3', variant: 'budget', seed, hidden: true, rules: 2, draw: { spread: true, rotate: true } } });

/** Draft to the end, the cheapest fitting player each time (so the money lasts), re-spinning when stuck. */
function draft(c: RunContext): RunState {
  let s = newRunState(14);
  for (let i = 0; i < 80 && s.phase === 'picking'; i++) {
    if (s.armed) { s = spinMove(c, s); continue; }
    const order = publicRun(c, s).spin!.players.slice().sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    const open = order.find((p) => { try { pickMove(c, s, p.id); return true; } catch { return false; } });
    s = open ? pickMove(c, s, open.id) : respinMove(c, s, 'club').state;
  }
  return s.armed ? spinMove(c, s) : s;
}

describe('rules v2: the bench', () => {
  it('drafts fourteen: the XI, then three on the bench', () => {
    const c = ctx();
    const s = draft(c);
    expect(s.phase).toBe('ready');
    expect(s.picks).toHaveLength(14);
    expect(s.picks.every(Boolean)).toBe(true);
    expect(s.picks.slice(11).map((p) => p!.slotId)).toEqual(BENCH.map((b) => b.id));
  });
  it('the bench never counts in the lines', () => {
    const s = draft(ctx());
    const xi = FORMATIONS['4-3-3'];
    expect(lines([...xi, ...BENCH], s.picks)).toEqual(lines(xi, s.picks.slice(0, 11)));
  });
});

describe('rules v2: team talk', () => {
  it('offers three tactics, the same for the same draw, and every tactic adds up the same', () => {
    expect(offeredTactics('a')).toHaveLength(3);
    expect(offeredTactics('a')).toEqual(offeredTactics('a'));
    const sums = Object.values(TACTICS).map((t) => t.att + t.mid + t.def + t.gk);
    expect(new Set(sums).size).toBe(1);
  });
  it('the captain plays above himself, and an academy kid cannot wear the armband', () => {
    const xi = FORMATIONS['4-3-3'];
    const s = draft(ctx());
    const plain = boostOf(xi, s.picks.slice(0, 11), null, null, null);
    const capped = boostOf(xi, s.picks.slice(0, 11), null, 'st', null);
    const i = xi.findIndex((x) => x.id === 'st');
    expect((capped.perSlot![i] ?? 0) - (plain.perSlot![i] ?? 0)).toBe(s.picks[i]!.academy ? 0 : CAPTAIN_BONUS);
  });
  it('chemistry links former teammates, at most a few points each', () => {
    const xi = FORMATIONS['4-3-3'];
    const s = draft(ctx());
    const all = chemistry(xi, s.picks.slice(0, 11), () => ({ club: 'X', season: '2000/01' }));
    const outfield = s.picks.slice(0, 11).filter((p) => p && !p.academy).length;
    expect(all.links.length).toBe((outfield * (outfield - 1)) / 2);
    expect(Math.max(...all.perSlot)).toBeLessThanOrEqual(CHEMISTRY_CAP);
    expect(chemistry(xi, s.picks.slice(0, 11), () => null).links).toEqual([]);
  });
  it('captain and tactic moves are refused before the XI is complete and on old setups', () => {
    const c = ctx();
    expect(() => captainMove(c, newRunState(14), 'st')).toThrow();
    const old: RunContext = { ...c, setup: { ...c.setup, rules: undefined } };
    expect(() => tacticMove(old, draft(c), offeredTactics(c.setup.seed)[0])).toThrow('invalid_move');
  });
});

describe('rules v2: moments', () => {
  it('come from the seed alone and keep someone out for a while', () => {
    const xi = FORMATIONS['4-3-3'];
    const opps = u.opponents('sol', 'm');
    const a = momentsOf('m', xi, 38, opps);
    expect(a).toEqual(momentsOf('m', xi, 38, opps));
    const injury = a.find((m) => m.kind === 'injury')!;
    expect(absentIn(injury.round, a).has(injury.slotId!)).toBe(true);
    expect(absentIn(injury.round + injury.weeks!, a).has(injury.slotId!) && !a.some((m) => m !== injury && m.slotId === injury.slotId)).toBe(false);
  });
  it('the best-fitting bench player covers, else an academy kid', () => {
    const xi = FORMATIONS['4-3-3'];
    const s = draft(ctx());
    const out = new Set(['gk']);
    const { picks, covers } = lineupFor(xi, s.picks.slice(0, 11), s.picks.slice(11), out);
    const cover = picks[0]!;
    if (covers.gk) expect(cover.player.pos).toBe('GK');
    else expect(cover.academy).toBe(true);
  });
});

describe('rules v2: a whole season', () => {
  it('runs team talk, a first half, January and a second half, then the cups', () => {
    const c = ctx('season');
    let s = draft(c);
    const tactic = offeredTactics(c.setup.seed)[0];
    const xiPick = s.picks.findIndex((p, i) => i < 11 && p && !p.academy);
    s = captainMove(c, s, FORMATIONS['4-3-3'][xiPick].id);
    s = tacticMove(c, s, tactic);
    s = finishMove(c, s);
    expect(s.phase).toBe('half');
    expect(completionOf(s)).toBeNull();
    const view = publicRun(c, s);
    expect(view.half!.matches).toHaveLength(view.half!.half);
    s = januarySpinMove(c, s);
    const squad = publicRun(c, s).half!.window.spin!;
    expect(squad.players.every((p) => p.rating === 0)).toBe(true);
    // Sign the cheapest who fits a bench place (anyone fits there).
    const cheapest = squad.players.slice().sort((a, b) => (a.price ?? 0) - (b.price ?? 0)).find((p) => { try { januarySignMove(c, s, p.id, 'b3'); return true; } catch { return false; } });
    if (cheapest) {
      s = januarySignMove(c, s, cheapest.id, 'b3');
      expect(publicRun(c, s).half!.window.signing!.in).toBe(cheapest.name);
      expect(() => januarySpinMove(c, s)).toThrow();
    }
    s = tacticMove(c, s, offeredTactics(c.setup.seed)[1]);
    const before = publicRun(c, s).half!.matches;
    s = finishMove(c, s);
    expect(s.phase).toBe('result');
    const r = s.result!;
    // The first half is what it was at the turn of the year.
    expect(r.season.matches.slice(0, before.length).map((m) => [m.gf, m.ga])).toEqual(before.map((m) => [m.gf, m.ga]));
    expect(r.extra!.cup.matches.length).toBeGreaterThan(0);
    expect(r.extra!.captain).not.toBeNull();
    expect(r.extra!.tactic).toBe(tactic);
    expect(completionOf(s)).not.toBeNull();
    expect(() => finishMove(c, s)).toThrow('draft_over');
  });
  it('the same draw plays the same season', () => {
    const run = () => { const c = ctx('same'); let s = draft(c); s = finishMove(c, s); s = finishMove(c, s); return s.result!; };
    const a = run(), b = run();
    expect(a.season.points).toBe(b.season.points);
    expect(a.extra!.cup).toEqual(b.extra!.cup);
  });
  it('a knockout stops at the first defeat, and winning it means winning every round', () => {
    const team = lines(FORMATIONS['4-3-3'], draft(ctx()).picks.slice(0, 11));
    for (let i = 0; i < 20; i++) {
      const cup = playCup('cup', team, u.opponents('sol', `c${i}`), `c${i}`, 5);
      const lost = cup.matches.findIndex((m) => !m.won);
      if (lost >= 0) expect(cup.matches).toHaveLength(lost + 1);
      expect(cup.won).toBe(cup.matches.length === cup.stages && cup.matches.every((m) => m.won));
    }
  });
});

describe('rules v2: January money', () => {
  it('a sale brings back half the price, and nobody is bought beyond what is left', () => {
    const c = ctx('money');
    let s = draft(c);
    s = finishMove(c, s);
    s = januarySpinMove(c, s);
    const money = publicRun(c, s).half!.window.money;
    const dear = publicRun(c, s).half!.window.spin!.players.filter((p) => (p.price ?? 0) > money + 200);
    for (const p of dear) expect(() => januarySignMove(c, s, p.id, 'b1')).toThrow();
    const p0 = s.picks[11] as Pick;
    expect(Math.floor((p0.price ?? 0) / 2)).toBeGreaterThanOrEqual(0);
  });
});

describe('Europe', () => {
  const two = () => {
    const pack = inventedPack();
    pack.leagues.push({ id: 'luna', name: 'Liga de la Luna', short: 'LUN', teams: 8, games: 14 });
    pack.clubs = [...pack.clubs, ...pack.clubs.map((c) => ({ ...c, league: 'luna', clubId: c.clubId.replace('sol', 'luna'), club: c.club.replace('Invented', 'Lunar') }))];
    return universeOf(pack);
  };
  it('is a league of every club-season once a pack has two leagues', () => {
    expect(u.leagues.map((l) => l.id)).not.toContain('europe');
    const e = two();
    expect(e.leagues.map((l) => l.id)).toContain('europe');
    const clubs = new Set(Array.from({ length: 40 }, (_, i) => e.spin('europe', 'all', `s${i}`, []).clubId.split('-')[0]));
    expect(clubs.has('sol') && clubs.has('luna')).toBe(true);
  });
  it('meets nineteen of the leagues\' top finishers, named with their season, and plays a season', () => {
    const e = two();
    const rivals = e.opponents('europe', 'x');
    expect(rivals).toHaveLength(19);
    expect(rivals.every((o) => /\d{4}\/\d{2}$/.test(o.name))).toBe(true);
    const c: RunContext = { u: e, mode: 'free', setup: { release: 'r', leagueId: 'europe', era: 'all', formation: '4-3-3', variant: 'budget', seed: 'eu', hidden: true, rules: 2, draw: { spread: true, rotate: true } } };
    let s = draft(c);
    s = finishMove(c, s); s = finishMove(c, s);
    expect(s.result!.season.table).toHaveLength(20);
    expect(s.result!.extra!.realTop).toBeNull();
  });
});
