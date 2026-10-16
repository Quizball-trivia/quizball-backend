import { describe, expect, it } from 'vitest';
import {
  applyCommand, afterOutage, DRAFT_PICK_MS, INTRO_MS, MAX_ROUNDS, PICK_MS, REVEAL_STEP_MS, SUSPENSE, seatsChanged, standings, startMatch, tick, viewOf,
  type FootballRaceContent, type FootballRaceState,
} from '../../src/modules/room/games/football-race/football-race.engine.js';
import { compare, dealRace, displayed, raceTournamentDataSchema, tournamentOrder, type RaceMetric, type RaceTournamentData } from '../../src/modules/room/games/football-race/football-race.rules.js';

// INVENTED nations and numbers (public repo). Nation A leads the a* stats, B the b*, C the c*, D the d*.
const L = (en: string) => ({ en, es: en, ka: en, tr: en });
const metric = (id: string, extra: Partial<RaceMetric> = {}): RaceMetric =>
  ({ id, family: 'results', dir: 'high', unwanted: false, decimals: 0, kind: 'count', label: L(id), keywords: '', ...extra });
const NATIONS = ['A', 'B', 'C', 'D'];
const leaderStats = NATIONS.flatMap((leader) => Array.from({ length: 9 }, (_, k) => ({
  id: `TT.all:${leader.toLowerCase()}${k}`, scope: 'TT.all', metric: `${leader.toLowerCase()}${k}`,
  values: Object.fromEntries(NATIONS.map((n) => [n, n === leader ? 50 + k : 10])),
  details: { [leader]: L(`${leader} detail ${k}`) },
})));
const DATA: RaceTournamentData = raceTournamentDataSchema.parse({
  release: 'test-1', cutoff: '2031-01-01', source: L('Invented'), tournament: { id: 'TT', label: L('Invented Cup') },
  nations: NATIONS.map((id, tier) => ({ id, code: id + id + id, flag: 'xx', name: L(`Nation ${id}`), tier })),
  scopes: [{ id: 'TT.all', label: L('All-time') }], families: [{ id: 'results', label: L('Results') }],
  metrics: [...leaderStats.map((s) => metric(s.metric)), metric('tieAB'), metric('low', { dir: 'low' })],
  stats: [...leaderStats,
    { id: 'TT.all:tieAB', scope: 'TT.all', metric: 'tieAB', values: { A: 9, B: 9, C: 1, D: 1 } },
    { id: 'TT.all:low', scope: 'TT.all', metric: 'low', values: { A: 4, B: 3, C: 2, D: 1 } }],
});
const content = (seed = 1): FootballRaceContent => ({ pack: { release: 'test-1', tournament: 'TT', seed }, data: DATA });

/** Plays the draft: every seat takes the nation that has its own letter order (seat 0 → first free). */
function draftAll(s0: FootballRaceState, c: FootballRaceContent, wanted: string[], now = 1000): FootballRaceState {
  let s = s0;
  while (s.phase === 'draft') {
    const seat = s.draftOrder[s.draftTurn];
    const nation = wanted[seat];
    const res = applyCommand(s, c, seat, { type: 'draft', turn: s.draftTurn, nation }, now);
    expect(res.error).toBeUndefined();
    s = res.state;
  }
  return s;
}
const toPick = (s: FootballRaceState, c: FootballRaceContent) => tick(s, c, s.deadline);
const stat = (nation: string, k: number) => `TT.all:${nation.toLowerCase()}${k}`;
/** Steps the reveal on its own deadlines until the next pick window (or the end). */
function revealAll(s0: FootballRaceState, c: FootballRaceContent): FootballRaceState {
  let s = s0;
  while (s.phase === 'reveal') s = tick(s, c, s.deadline);
  return s;
}

describe('rules', () => {
  it('compares among the nations still racing and refuses level or same-on-screen values', () => {
    const m = metric('x');
    const st = { id: 'x', scope: 'TT.all', metric: 'x', values: { A: 5, B: 9, C: 1 } };
    expect(compare(st, m, ['A', 'B', 'C'])?.leaders).toEqual([1]);
    expect(compare(st, m, ['A', 'B', 'C'], [true, false, true])?.leaders).toEqual([0]);
    expect(compare({ ...st, values: { A: 5, B: 5, C: 5 } }, m, ['A', 'B', 'C'])).toBeNull();
    expect(compare({ ...st, values: { A: 5, B: 9 } }, m, ['A', 'B', 'C'])).toBeNull();
    const rate = metric('r', { decimals: 1 });
    expect(displayed(2.55, 1)).toBe(displayed(2.56, 1));
    expect(compare({ ...st, values: { A: 2.55, B: 2.56, C: 1 } }, rate, ['A', 'B', 'C'])).toBeNull();
  });
  it('deals distinct, balanced nations, the same for the same seed', () => {
    for (const seats of [2, 3, 4]) {
      const d = dealRace(DATA, seats, 7)!;
      expect(new Set(d.racers).size).toBe(seats);
      expect(dealRace(DATA, seats, 7)).toEqual(d);
      expect(d.fair).toBe(true);
    }
    expect(dealRace(DATA, 5, 1)).toBeNull();
  });
  it('orders tournaments by seed, the same every time', () => {
    expect(tournamentOrder(['WC', 'NL', 'GOLD'], 3)).toEqual(tournamentOrder(['WC', 'NL', 'GOLD'], 3));
    expect(new Set(tournamentOrder(['WC', 'NL', 'GOLD'], 3))).toEqual(new Set(['WC', 'NL', 'GOLD']));
  });
});

describe('draft', () => {
  it('takes turns in a seeded order; the last seat gets the nation left over', () => {
    const c = content();
    let s = startMatch(3, c, 0);
    expect(s.phase).toBe('draft');
    expect([...s.draftOrder].sort()).toEqual([0, 1, 2]);
    const [first, second] = s.draftOrder;
    expect(applyCommand(s, c, second, { type: 'draft', turn: 0, nation: s.racers[0] }, 10).error).toBe('not_your_turn');
    expect(applyCommand(s, c, first, { type: 'draft', turn: 1, nation: s.racers[0] }, 10).error).toBe('stale');
    expect(applyCommand(s, c, first, { type: 'draft', turn: 0, nation: 'ZZZ' }, 10).error).toBe('taken');
    s = applyCommand(s, c, first, { type: 'draft', turn: 0, nation: s.racers[0] }, 10).state;
    expect(applyCommand(s, c, second, { type: 'draft', turn: 1, nation: s.racers[0] }, 20).error).toBe('taken');
    s = applyCommand(s, c, second, { type: 'draft', turn: 1, nation: s.racers[1] }, 20).state;
    expect(s.phase).toBe('intro');
    expect(new Set(s.nationOf)).toEqual(new Set([0, 1, 2]));
  });
  it('gives a seat whose clock ran out a random free nation, marked automatic', () => {
    const c = content();
    const s0 = startMatch(2, c, 0);
    expect(tick(s0, c, DRAFT_PICK_MS - 1)).toBe(s0);
    const s = tick(s0, c, DRAFT_PICK_MS);
    expect(s.phase).toBe('intro');
    expect(s.draftAuto[s0.draftOrder[0]]).toBe(true);
  });
  it('a seat that left before its draft turn is given a nation at once', () => {
    const c = content();
    let s = startMatch(3, c, 0);
    const later = s.draftOrder[1];
    s = seatsChanged(s, [{ seat: later, change: 'leave' }], 5);
    s = applyCommand(s, c, s.draftOrder[0], { type: 'draft', turn: 0, nation: s.racers[0] }, 10).state;
    expect(s.deadline).toBe(10);
    s = tick(s, c, 10);
    expect(s.phase).toBe('intro');
  });
});

describe('race', () => {
  const toIntro = (seats: number) => {
    const c = content();
    const s0 = startMatch(seats, c, 0);
    return draftAll(s0, c, s0.draftOrder.map((_, seat) => s0.racers[seat]));
  };
  const setup = (seats: number) => {
    const c = content();
    const s0 = startMatch(seats, c, 0);
    const wanted = s0.draftOrder.map(() => '').map((_, seat) => s0.racers[seat]);
    const s = toPick(draftAll(s0, c, wanted), c);
    expect(s.phase).toBe('pick');
    return { c, s, nationOfSeat: (seat: number) => s.racers[s.nationOf[seat]!] };
  };

  it('after the last round the furthest nation wins, and level leaders share it', () => {
    const { c, s: s0, nationOfSeat } = setup(2);
    const last = (positions: number[]) => {
      let s: FootballRaceState = { ...s0, round: MAX_ROUNDS - 1, positions };
      s = applyCommand(s, c, 0, { type: 'pick', round: s.round, stat: stat(nationOfSeat(0), 0) }, s.deadline - 2).state;
      return revealAll(applyCommand(s, c, 1, { type: 'pick', round: s.round, stat: stat(nationOfSeat(1), 0) }, s.deadline - 1).state, c);
    };
    const ahead = last([2, 1]);
    expect([ahead.phase, ahead.endedBy, ahead.winners]).toEqual(['over', 'rounds', [0]]);
    const level = last([1, 1]);
    expect([level.endedBy, level.winners]).toEqual(['rounds', [0, 1]]);
  });

  it('when the last playable stats are played the match ends on them, furthest nation first', () => {
    const { c, s: s0, nationOfSeat } = setup(2);
    const left = [stat(nationOfSeat(0), 0), stat(nationOfSeat(1), 0)];
    let s: FootballRaceState = { ...s0, positions: [1, 0], used: DATA.stats.map((x) => x.id).filter((id) => !left.includes(id)) };
    s = applyCommand(s, c, 0, { type: 'pick', round: s.round, stat: left[0] }, s.deadline - 2).state;
    s = revealAll(applyCommand(s, c, 1, { type: 'pick', round: s.round, stat: left[1] }, s.deadline - 1).state, c);
    expect([s.phase, s.endedBy, s.winners, s.positions]).toEqual(['over', 'stats', [0], [2, 1]]);
  });

  it('moves the nation that leads a pick, whoever picked it, one step at a time on its own deadlines', () => {
    const { c, s: s0, nationOfSeat } = setup(2);
    const t = s0.deadline - PICK_MS + 100;
    let s = applyCommand(s0, c, 1, { type: 'pick', round: 0, stat: stat(nationOfSeat(0), 0) }, t).state;
    expect(s.phase).toBe('pick');
    s = applyCommand(s, c, 0, { type: 'pick', round: 0, stat: stat(nationOfSeat(0), 1) }, t + 50).state;
    expect(s).toMatchObject({ phase: 'reveal', revealIndex: 0, revealOpen: false });
    expect(s.reveal).toHaveLength(2);
    expect(s.reveal!.map((r) => r.seat)).toEqual([1, 0]);
    expect(s.positions).toEqual([0, 0]);
    expect(tick(s, c, s.deadline - 1)).toBe(s);
    s = tick(s, c, s.deadline);
    expect(s.positions).toEqual([1, 0]);
    s = revealAll(s, c);
    expect(s.positions).toEqual([2, 0]);
    expect(s.phase).toBe('pick');
    expect(s.round).toBe(1);
  });

  it('refuses a pick that is late, repeated, for another round, unknown or already played', () => {
    const { c, s: s0, nationOfSeat } = setup(2);
    const t = s0.deadline - 1000;
    let s = applyCommand(s0, c, 0, { type: 'pick', round: 0, stat: stat(nationOfSeat(0), 0) }, t).state;
    expect(applyCommand(s, c, 0, { type: 'pick', round: 0, stat: stat(nationOfSeat(0), 1) }, t).error).toBe('already_picked');
    expect(applyCommand(s, c, 1, { type: 'pick', round: 1, stat: stat(nationOfSeat(1), 1) }, t).error).toBe('stale');
    expect(applyCommand(s, c, 1, { type: 'pick', round: 0, stat: 'TT.all:nope' }, t).error).toBe('unknown_stat');
    expect(applyCommand(s, c, 1, { type: 'pick', round: 0, stat: stat(nationOfSeat(1), 1) }, s.deadline).error).toBe('not_open');
    s = revealAll(applyCommand(s, c, 1, { type: 'pick', round: 0, stat: stat(nationOfSeat(1), 1) }, t).state, c);
    expect(applyCommand(s, c, 1, { type: 'pick', round: 1, stat: stat(nationOfSeat(0), 0) }, s.deadline - 1).error).toBe('stat_used');
  });

  it('draws a random unused stat for a seat whose clock ran out, revealed last and marked automatic', () => {
    const { c, s: s0, nationOfSeat } = setup(3);
    let s = applyCommand(s0, c, 0, { type: 'pick', round: 0, stat: stat(nationOfSeat(0), 0) }, s0.deadline - 1000).state;
    s = tick(s, c, s.deadline);
    expect(s.phase).toBe('reveal');
    expect(s.reveal![0].seat).toBe(0);
    expect(s.reveal!.slice(1).every((r) => r.auto)).toBe(true);
    expect(new Set(s.reveal!.map((r) => r.stat)).size).toBe(3);
  });

  it('ends on the pick that puts a nation on the line; later picks are never shown, and the count never tells', () => {
    const { c, s: s0, nationOfSeat } = setup(2);
    let s = s0;
    for (let k = 0; k < 4; k += 1) {
      s = applyCommand(s, c, 0, { type: 'pick', round: s.round, stat: stat(nationOfSeat(0), k) }, s.deadline - 2000).state;
      s = revealAll(applyCommand(s, c, 1, { type: 'pick', round: s.round, stat: stat(nationOfSeat(0), k + 4) }, s.deadline - 1000).state, c);
      if (s.phase !== 'pick') break;
    }
    // 2 + 2 + (the fifth arrives on seat 0's own pick in round 2): seat 0 wins without the second pick being shown.
    expect(s.phase).toBe('over');
    expect(s.winners).toEqual([0]);
    expect(s.endedBy).toBe('line');
    expect(standings(s)[0]).toMatchObject({ seat: 0, place: 1, points: 5 });
  });

  it('a nation whose player left no longer moves or wins; stats are compared among those still racing', () => {
    const { c, s: s0, nationOfSeat } = setup(3);
    let s = seatsChanged(s0, [{ seat: 2, change: 'leave' }], s0.deadline - 5000);
    // Its stats no longer split the two still racing: not playable, and gone from the list.
    expect(applyCommand(s, c, 0, { type: 'pick', round: 0, stat: stat(nationOfSeat(2), 0) }, s0.deadline - 4000).error).toBe('unknown_stat');
    expect(viewOf(s, c, 0, 'en').stats.some((x) => x.id === stat(nationOfSeat(2), 0))).toBe(false);
    s = applyCommand(s, c, 0, { type: 'pick', round: 0, stat: stat(nationOfSeat(0), 0) }, s0.deadline - 4000).state;
    s = applyCommand(s, c, 1, { type: 'pick', round: 0, stat: stat(nationOfSeat(1), 0) }, s0.deadline - 3000).state;
    expect(s.phase).toBe('reveal');
    s = revealAll(s, c);
    expect(s.rounds[0].every((r) => !r.leaders.includes(2))).toBe(true);
    expect(s.positions[2]).toBe(0);
    expect(standings(s).at(-1)).toMatchObject({ seat: 2, place: 3 });
  });

  it('everyone still in has picked while one is away: the window closes on the next tick', () => {
    const { c, s: s0, nationOfSeat } = setup(3);
    let s = seatsChanged(s0, [{ seat: 2, change: 'away' }], s0.deadline - 9000);
    s = applyCommand(s, c, 0, { type: 'pick', round: 0, stat: stat(nationOfSeat(0), 0) }, s0.deadline - 8000).state;
    s = applyCommand(s, c, 1, { type: 'pick', round: 0, stat: stat(nationOfSeat(1), 0) }, s0.deadline - 7000).state;
    expect(s.phase).toBe('reveal');
    expect(s.reveal!.find((r) => r.seat === 2)?.auto).toBe(true);
  });

  it('cancels when a player leaves during the draft, and gives the race to whoever stays once it is drafted', () => {
    const drafting = startMatch(2, content(), 0);
    expect(seatsChanged(drafting, [{ seat: 1, change: 'leave' }], 10).phase).toBe('cancelled');
    const { s: s0 } = setup(2);
    expect(seatsChanged(s0, [{ seat: 1, change: 'leave' }], 10)).toMatchObject({ phase: 'over', winners: [0], endedBy: 'left' });
    const intro = toIntro(2);
    expect(intro.phase).toBe('intro');
    expect(seatsChanged(intro, [{ seat: 0, change: 'leave' }], 10)).toMatchObject({ phase: 'over', winners: [1], endedBy: 'left' });
    // Everyone leaving together crowns nobody.
    expect(seatsChanged(intro, [{ seat: 0, change: 'leave' }, { seat: 1, change: 'leave' }], 10).phase).toBe('cancelled');
    expect(seatsChanged(s0, [{ seat: 0, change: 'leave' }, { seat: 1, change: 'leave' }], 10).phase).toBe('cancelled');
    const c = content();
    const { s: s1, nationOfSeat } = setup(2);
    let s = applyCommand(s1, c, 0, { type: 'pick', round: 0, stat: stat(nationOfSeat(0), 0) }, s1.deadline - 2000).state;
    s = revealAll(applyCommand(s, c, 1, { type: 'pick', round: 0, stat: stat(nationOfSeat(1), 0) }, s1.deadline - 1000).state, c);
    s = seatsChanged(s, [{ seat: 1, change: 'leave' }], s.deadline - 1);
    expect(s).toMatchObject({ phase: 'over', winners: [0], endedBy: 'left' });
  });

  it('after an outage the open window starts again', () => {
    const { s } = setup(2);
    expect(afterOutage(s, 999_999).deadline).toBe(999_999 + PICK_MS);
    expect(afterOutage(startMatch(2, content(), 0), 50).deadline).toBe(50 + DRAFT_PICK_MS);
  });
});

describe('found in review', () => {
  const setup3 = () => {
    const c = content();
    const s0 = startMatch(3, c, 0);
    const s = toPick(draftAll(s0, c, [s0.racers[0], s0.racers[1], s0.racers[2]]), c);
    return { c, s, nat: (seat: number) => s.racers[s.nationOf[seat]!] };
  };

  it('a nation whose player leaves mid-reveal does not move on a pick opened after it left', () => {
    const { c, s: s0, nat } = setup3();
    let s = applyCommand(s0, c, 0, { type: 'pick', round: 0, stat: stat(nat(0), 0) }, s0.deadline - 3000).state;
    s = applyCommand(s, c, 1, { type: 'pick', round: 0, stat: stat(nat(1), 0) }, s0.deadline - 2000).state;
    s = applyCommand(s, c, 2, { type: 'pick', round: 0, stat: stat(nat(2), 0) }, s0.deadline - 1000).state;
    expect(s.reveal!.map((r) => r.seat)).toEqual([0, 1, 2]);
    s = tick(s, c, s.deadline);                       // seat 0's pick opens
    s = seatsChanged(s, [{ seat: 2, change: 'leave' }], s.deadline - 1);
    s = revealAll(s, c);
    // Seat 2's own stat opened after it left: it no longer splits the two still racing, so nobody moved.
    expect(s.positions).toEqual([1, 1, 0]);
    expect(s.rounds[0][2]).toMatchObject({ seat: 2, leaders: [] });
  });

  it('the step that reaches the line ends the match at once; a leave after it changes nothing', () => {
    const c = content();
    const s0 = startMatch(2, c, 0);
    let s = toPick(draftAll(s0, c, [s0.racers[0], s0.racers[1]]), c);
    const n0 = s.racers[s.nationOf[0]!];
    for (let k = 0; k < 2; k += 1) {
      s = applyCommand(s, c, 0, { type: 'pick', round: s.round, stat: stat(n0, k) }, s.deadline - 2000).state;
      s = revealAll(applyCommand(s, c, 1, { type: 'pick', round: s.round, stat: stat(n0, k + 4) }, s.deadline - 1000).state, c);
    }
    expect(s.positions[0]).toBe(4);
    s = applyCommand(s, c, 0, { type: 'pick', round: s.round, stat: stat(n0, 2) }, s.deadline - 2000).state;
    s = applyCommand(s, c, 1, { type: 'pick', round: s.round, stat: stat(n0, 3) }, s.deadline - 1000).state;
    s = tick(s, c, s.deadline);
    expect(s).toMatchObject({ phase: 'over', winners: [0], endedBy: 'line' });
    expect(viewOf(s, c, 1, 'en').finale?.stat).toBe(stat(n0, 2));
    expect(seatsChanged(s, [{ seat: 0, change: 'leave' }], s.deadline + 1)).toBe(s);
  });

  it('a seat view is the same whichever stat an opponent picked, until that pick opens', () => {
    const { c, s: s0, nat } = setup3();
    const make = (opponentStat: string) => {
      let s = applyCommand(s0, c, 0, { type: 'pick', round: 0, stat: stat(nat(0), 0) }, s0.deadline - 3000).state;
      s = applyCommand(s, c, 1, { type: 'pick', round: 0, stat: stat(nat(1), 0) }, s0.deadline - 2000).state;
      s = applyCommand(s, c, 2, { type: 'pick', round: 0, stat: opponentStat }, s0.deadline - 1000).state;
      s = tick(s, c, s.deadline);
      // Seat 2 leaves while its pick waits in the reveal: its own stats stop splitting the two still racing.
      return viewOf(seatsChanged(s, [{ seat: 2, change: 'leave' }], s.deadline - 1), c, 0, 'en');
    };
    expect(make(stat(nat(2), 5))).toEqual(make(stat(nat(2), 6)));
  });

  it('the stat on the reveal card is listed for its label, even once it no longer splits the nations racing', () => {
    const { c, s: s0, nat } = setup3();
    let s = applyCommand(s0, c, 2, { type: 'pick', round: 0, stat: stat(nat(2), 5) }, s0.deadline - 3000).state;
    s = applyCommand(s, c, 0, { type: 'pick', round: 0, stat: stat(nat(0), 0) }, s0.deadline - 2000).state;
    s = applyCommand(s, c, 1, { type: 'pick', round: 0, stat: stat(nat(1), 0) }, s0.deadline - 1000).state;
    // Everyone has picked: the reveal starts, its first card (seat 2's pick, the fastest) not open yet.
    expect(s).toMatchObject({ phase: 'reveal', revealIndex: 0, revealOpen: false });
    s = seatsChanged(s, [{ seat: 2, change: 'leave' }], s.deadline - 1);
    const view = viewOf(s, c, 0, 'en');
    expect(view.reveal).toMatchObject({ index: 0, open: false, item: { stat: stat(nat(2), 5), values: [] } });
    expect(view.stats.map((x) => x.id)).toContain(stat(nat(2), 5));
    expect(view.stats.map((x) => x.id)).not.toContain(stat(nat(2), 6));
  });

  it('a seat keeps seeing its own pick after a departure makes that stat unplayable', () => {
    const { c, s: s0, nat } = setup3();
    // Seat 0 backs seat 2's nation; seat 2 then leaves, so that stat no longer splits the two still racing.
    let s = applyCommand(s0, c, 0, { type: 'pick', round: 0, stat: stat(nat(2), 4) }, s0.deadline - 3000).state;
    s = seatsChanged(s, [{ seat: 2, change: 'leave' }], s0.deadline - 2000);
    const own = viewOf(s, c, 0, 'en');
    expect(own.myPick).toBe(stat(nat(2), 4));
    expect(own.stats.map((x) => x.id)).toContain(stat(nat(2), 4));
    expect(viewOf(s, c, 1, 'en').stats.map((x) => x.id)).not.toContain(stat(nat(2), 4));
  });

  it('ends when no playable stat is left instead of opening empty rounds', () => {
    const { c, s: s0, nat } = setup3();
    let s = seatsChanged(s0, [{ seat: 2, change: 'leave' }], s0.deadline - 5000);
    const mine = Array.from({ length: 9 }, (_, k) => [stat(nat(0), k), stat(nat(1), k)]);
    // Tie stats (A=B) and the low stat split them too; play them first, then each seat's own.
    s = applyCommand(s, c, 0, { type: 'pick', round: s.round, stat: 'TT.all:low' }, s.deadline - 2).state;
    s = revealAll(applyCommand(s, c, 1, { type: 'pick', round: s.round, stat: 'TT.all:tieAB' }, s.deadline - 1).state, c);
    for (const [a, b] of mine) {
      if (s.phase !== 'pick') break;
      s = applyCommand(s, c, 0, { type: 'pick', round: s.round, stat: a }, s.deadline - 2).state;
      s = revealAll(applyCommand(s, c, 1, { type: 'pick', round: s.round, stat: b }, s.deadline - 1).state, c);
    }
    expect(s.phase).toBe('over');
    expect(['line', 'stats']).toContain(s.endedBy);
  });

  it('closes the window when the last seat without a pick goes away', () => {
    const { c, s: s0, nat } = setup3();
    let s = applyCommand(s0, c, 0, { type: 'pick', round: 0, stat: stat(nat(0), 0) }, s0.deadline - 3000).state;
    s = applyCommand(s, c, 1, { type: 'pick', round: 0, stat: stat(nat(1), 0) }, s0.deadline - 2000).state;
    s = seatsChanged(s, [{ seat: 2, change: 'away' }], s0.deadline - 1000);
    expect(s.deadline).toBe(s0.deadline - 1000);
    s = tick(s, c, s.deadline);
    expect(s.phase).toBe('reveal');
    expect(s.reveal!.find((r) => r.seat === 2)?.auto).toBe(true);
  });

  it('a seat that leaves during the pick window loses the pick it made', () => {
    const { c, s: s0, nat } = setup3();
    let s = applyCommand(s0, c, 2, { type: 'pick', round: 0, stat: stat(nat(2), 0) }, s0.deadline - 3000).state;
    s = seatsChanged(s, [{ seat: 2, change: 'leave' }], s0.deadline - 2500);
    s = applyCommand(s, c, 0, { type: 'pick', round: 0, stat: stat(nat(0), 0) }, s0.deadline - 2000).state;
    s = applyCommand(s, c, 1, { type: 'pick', round: 0, stat: stat(nat(1), 0) }, s0.deadline - 1000).state;
    expect(s.reveal!.map((r) => r.seat).sort()).toEqual([0, 1]);
  });

  it('two seats picking the same stat both count; level pick times keep a fixed order', () => {
    const { c, s: s0, nat } = setup3();
    let s = applyCommand(s0, c, 1, { type: 'pick', round: 0, stat: stat(nat(0), 0) }, 500).state;
    s = applyCommand(s, c, 2, { type: 'pick', round: 0, stat: stat(nat(0), 0) }, 500).state;
    s = applyCommand(s, c, 0, { type: 'pick', round: 0, stat: stat(nat(0), 1) }, 500).state;
    expect(s.reveal!.map((r) => r.seat)).toEqual([0, 1, 2]);
    s = revealAll(s, c);
    expect(s.positions[0]).toBe(3);
  });

  it('the same seed deals the same nations for every admitted count it was checked for', () => {
    for (const seats of [2, 3, 4]) {
      expect(startMatch(seats, content(9), 0).racers).toEqual(dealRace(DATA, seats, 9)!.racers);
    }
  });
});

describe('the seat view', () => {
  it('never carries a value, a detail or another seat\'s pick before its reveal', () => {
    const c = content();
    const s0 = startMatch(2, c, 0);
    let s = toPick(draftAll(s0, c, [s0.racers[0], s0.racers[1]]), c);
    const n0 = s.racers[s.nationOf[0]!];
    s = applyCommand(s, c, 1, { type: 'pick', round: 0, stat: stat(n0, 3) }, s.deadline - 2000).state;
    const { stats: catalogue, ...mine } = viewOf(s, c, 0, 'en');
    // The catalogue lists every stat's wording; nothing else may say which one seat 1 took.
    expect(catalogue.some((x) => x.id === stat(n0, 3))).toBe(true);
    expect(mine.myPick).toBeNull();
    expect(mine.seats[1].picked).toBe(true);
    expect(JSON.stringify(mine)).not.toContain(stat(n0, 3));
    expect(viewOf(s, c, 1, 'en').myPick).toBe(stat(n0, 3));
    s = applyCommand(s, c, 0, { type: 'pick', round: 0, stat: stat(n0, 4) }, s.deadline - 1000).state;
    const { stats: _c1, ...early } = viewOf(s, c, 0, 'en');
    expect(early.reveal).toMatchObject({ index: 0, total: 2, open: false, item: { values: [], leaders: [], details: [] } });
    expect(JSON.stringify(early)).not.toMatch(/detail \d/);
    expect(JSON.stringify(early)).not.toContain('"values":[5');
    s = tick(s, c, s.deadline);
    const { stats: _c2, ...open } = viewOf(s, c, 0, 'en');
    expect(open.reveal?.open).toBe(true);
    expect(open.reveal?.item.values.length).toBe(2);
    expect(open.history).toHaveLength(1);
    // Seat 1 picked first, so its pick is the one out; seat 0's own pick is still to come.
    expect(open.history[0].stat).toBe(stat(n0, 3));
    expect(JSON.stringify(open)).not.toContain(stat(n0, 4));
  });
  it('shows the intro and the draft without any values', () => {
    const c = content();
    const v = viewOf(startMatch(2, c, 0), c, 0, 'es');
    expect(v.phase).toBe('draft');
    expect(JSON.stringify(v)).not.toMatch(/"values"/);
    expect(v.tournament.label).toBe('Invented Cup');
    expect(INTRO_MS).toBeGreaterThan(0);
    expect(REVEAL_STEP_MS * SUSPENSE).toBeGreaterThan(0);
  });
});
