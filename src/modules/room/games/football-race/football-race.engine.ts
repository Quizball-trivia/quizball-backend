import { z } from 'zod';
import type { RoomEngineStanding, RoomEngineState, RoomSeatChange } from '../../room.engine.js';
import type { RoomLocale } from '../../room.types.js';
import { compare, dealRace, l10n, MAX_SEATS, rng, targetFor, type L10n, type RaceTournamentData } from './football-race.rules.js';

/**
 * Football Horserace as a room game (2–4 seats), pure: time comes in as `now` (the database clock read under the match
 * lock); every random pick comes from the pack's seed and a counter kept in the state.
 *
 * 1. Draft: the dealt nations are picked in turn (a random order); the last seat gets the one left.
 * 2. Each round every seat secretly picks one unused stat of the tournament. When every seat that is in has picked, or
 *    the clock runs out (a missing pick is drawn at random), the picks are shown one at a time, fastest first (in the
 *    order the server took them): the question, then the values, and the racer that leads it moves one space, whoever
 *    picked it. Two seats may pick the same stat: each pick counts.
 * 3. The step that puts a racer on the line ends the match there and then (a tie that takes several there together
 *    shares the win); later picks of that round are never shown. Out of playable stats or rounds, the furthest wins.
 *
 * A seat that leaves retires its nation: it no longer moves or wins, its pick not yet made is dropped, and every pick
 * still to be shown is judged when it opens, among the nations still racing (a stat that no longer splits them moves
 * nobody). Every step on screen is its own transition with its own deadline, so nothing about a pick reaches a seat
 * early, and the result is fixed the moment it happens.
 */
export const DRAFT_PICK_MS = 10_000;
export const INTRO_MS = 4_000;
export const PICK_MS = 30_000;
export const REVEAL_STEP_MS = 4_200;
/** Share of a reveal step spent on the question before the values come out. */
export const SUSPENSE = 0.3;
export const REVEAL_TAIL_MS = 1_600;
export const MAX_ROUNDS = 12;

/** A match is a release, a tournament and a seed: the nations are dealt at the start, for exactly the seats admitted. */
export const footballRacePackSchema = z.object({
  release: z.string().min(3).max(60),
  tournament: z.string().min(1).max(20),
  seed: z.number().int().min(0).max(0xffffffff),
}).strict();
export type FootballRacePack = z.infer<typeof footballRacePackSchema>;
/** The stored pack, plus (in memory only) the tournament data of its release. */
export interface FootballRaceContent { pack: FootballRacePack; data: RaceTournamentData | null }

export const footballRaceCommandSchema = z.discriminatedUnion('type', [
  /** `turn`: the draft turn this pick is for (from the view), so a late or repeated send is never applied twice. */
  z.object({ type: z.literal('draft'), turn: z.number().int().min(0).max(MAX_SEATS), nation: z.string().min(1).max(60) }).strict(),
  z.object({ type: z.literal('pick'), round: z.number().int().min(0).max(MAX_ROUNDS), stat: z.string().min(1).max(100) }).strict(),
]);
export type FootballRaceCommand = z.infer<typeof footballRaceCommandSchema>;

export type Phase = 'draft' | 'intro' | 'pick' | 'reveal' | 'over' | 'cancelled';
export type EndReason = 'line' | 'stats' | 'rounds' | 'left';

/** A pick waiting in this round's reveal: who picked what, judged only when it opens. */
export interface QueuedPick { seat: number; stat: string; auto: boolean }

export interface PickResult {
  seat: number;
  stat: string;
  /** Picked by the clock, not the player. */
  auto: boolean;
  /** Value per seat's nation. */
  values: number[];
  /** Seats whose nation leads it (several = a tie: all move). */
  leaders: number[];
}

export interface FootballRaceState extends RoomEngineState {
  phase: Phase;
  /** The balanced nations dealt at the start (the draft assigns them to seats) and the stats playable for them. */
  racers: string[];
  statIds: string[];
  /** Draft: seats in picking order, the turn, the dealt nation (index into pack.racers) per seat. */
  draftOrder: number[];
  draftTurn: number;
  nationOf: Array<number | null>;
  draftAuto: boolean[];
  round: number;
  positions: number[];
  picks: Array<string | null>;
  pickedAt: Array<number | null>;
  /** Stats already shown (judged): they cannot be picked again. */
  used: string[];
  /** This round's picks in reveal order (the count is public: a race that ends early never says so in advance). */
  reveal: QueuedPick[] | null;
  /** This round's picks already opened and judged. */
  revealed: PickResult[];
  revealIndex: number;
  revealOpen: boolean;
  /** Earlier rounds' judged picks. */
  rounds: PickResult[][];
  winners: number[] | null;
  endedBy: EndReason | null;
  /** Random draws taken (draft order, clock picks): the next one uses the next counter. */
  draws: number;
  /** Seats that left while the race was still open: they rank below everyone who stayed. */
  quit: boolean[];
}

export type CommandError = 'not_open' | 'stale' | 'not_your_turn' | 'withdrawn' | 'taken' | 'already_picked' | 'unknown_stat' | 'stat_used';

const fill = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);
const ended = (s: FootballRaceState) => s.phase === 'over' || s.phase === 'cancelled';
const dataOf = (c: FootballRaceContent): RaceTournamentData => {
  if (!c.data) throw new Error('football_race content is not hydrated');
  return c.data;
};
const draw = (seed: number, n: number) => rng((seed ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0)();
const racersOf = (s: FootballRaceState) => s.nationOf.map((i) => (i === null ? '' : s.racers[i]));
const racing = (s: FootballRaceState) => s.status.map((st) => st !== 'withdrawn');

export function startMatch(seats: number, content: FootballRaceContent, now: number): FootballRaceState {
  if (seats < 2 || seats > MAX_SEATS) throw new Error(`A Football Horserace room needs 2 to ${MAX_SEATS} admitted seats`);
  // The deal checked at creation that this tournament seats every count up to the room's, so this always deals.
  const deal = dealRace(dataOf(content), seats, content.pack.seed);
  if (!deal) throw new Error('football_race: no playable deal for the admitted seats');
  const order = Array.from({ length: seats }, (_, seat) => ({ seat, k: draw(content.pack.seed, seat) })).sort((a, b) => a.k - b.k).map((x) => x.seat);
  return {
    phase: 'draft', deadline: now + DRAFT_PICK_MS, status: fill(seats, 'in'), racers: deal.racers, statIds: deal.statIds, draftOrder: order, draftTurn: 0, nationOf: fill<number | null>(seats, null),
    draftAuto: fill(seats, false), round: 0, positions: fill(seats, 0), picks: fill<string | null>(seats, null), pickedAt: fill<number | null>(seats, null),
    used: [], reveal: null, revealed: [], revealIndex: 0, revealOpen: false, rounds: [], winners: null, endedBy: null, draws: seats, quit: fill(seats, false),
  };
}

// ---------------------------------------------------------------- draft

function takeNation(s: FootballRaceState, seat: number, nation: number, auto: boolean, now: number): FootballRaceState {
  const nationOf = s.nationOf.map((n, i) => (i === seat ? nation : n));
  const draftAuto = s.draftAuto.map((a, i) => (i === seat ? auto : a));
  let next: FootballRaceState = { ...s, nationOf, draftAuto, draftTurn: s.draftTurn + 1 };
  // The last seat has one nation left: it is theirs, no clock.
  if (next.draftTurn === s.draftOrder.length - 1) {
    const last = s.draftOrder[s.draftOrder.length - 1];
    const left = [...Array(nationOf.length).keys()].find((n) => !nationOf.includes(n))!;
    next = { ...next, nationOf: nationOf.map((n, i) => (i === last ? left : n)), draftTurn: s.draftOrder.length };
  }
  if (next.draftTurn >= s.draftOrder.length) return { ...next, phase: 'intro', deadline: now + INTRO_MS };
  // A seat that already left gets its nation on the next tick, at once.
  const onTurn = next.draftOrder[next.draftTurn];
  return { ...next, deadline: next.status[onTurn] === 'withdrawn' ? now : now + DRAFT_PICK_MS };
}

function autoNation(s: FootballRaceState, seed: number, now: number): FootballRaceState {
  const seat = s.draftOrder[s.draftTurn];
  const free = [...Array(s.nationOf.length).keys()].filter((n) => !s.nationOf.includes(n));
  const nation = free[Math.floor(draw(seed, s.draws) * free.length)];
  return takeNation({ ...s, draws: s.draws + 1 }, seat, nation, true, now);
}

// ---------------------------------------------------------------- rounds

interface Index { statOf: Map<string, RaceTournamentData['stats'][number]>; metricOf: Map<string, RaceTournamentData['metrics'][number]>; nationOf: Map<string, RaceTournamentData['nations'][number]> }
const indexes = new WeakMap<RaceTournamentData, Index>();
/** Lookups over a release's tournament, built once per hydrated payload (views run for every seat on every change). */
function indexOf(data: RaceTournamentData): Index {
  let ix = indexes.get(data);
  if (!ix) {
    ix = { statOf: new Map(data.stats.map((x) => [x.id, x])), metricOf: new Map(data.metrics.map((m) => [m.id, m])), nationOf: new Map(data.nations.map((n) => [n.id, n])) };
    indexes.set(data, ix);
  }
  return ix;
}

/** Who leads a stat among the nations still racing; null when it no longer splits them. */
function judge(s: FootballRaceState, c: FootballRaceContent, stat: string) {
  const ix = indexOf(dataOf(c));
  const st = ix.statOf.get(stat);
  return st ? compare(st, ix.metricOf.get(st.metric)!, racersOf(s), racing(s)) : null;
}
const playableLeft = (s: FootballRaceState, c: FootballRaceContent) => s.statIds.filter((id) => !s.used.includes(id) && judge(s, c, id));

function openRound(s: FootballRaceState, round: number, now: number): FootballRaceState {
  return {
    ...s, phase: 'pick', round, picks: s.picks.map(() => null), pickedAt: s.pickedAt.map(() => null),
    reveal: null, revealed: [], revealIndex: 0, revealOpen: false, deadline: now + PICK_MS,
  };
}

/** The window closes: seats still racing without a pick get a random playable stat; the picks queue up, fastest first. */
function settle(s: FootballRaceState, c: FootballRaceContent, now: number): FootballRaceState {
  const active = racing(s);
  const unused = playableLeft(s, c);
  const chosen = new Set(s.picks.filter((p): p is string => p !== null));
  const fresh = unused.filter((id) => !chosen.has(id));
  let draws = s.draws;
  const auto: boolean[] = [];
  const picks = s.picks.map((p, seat) => {
    auto[seat] = p === null;
    // A seat that left drops the pick it made; one that is in (or away) without a pick gets one from the clock.
    if (!active[seat]) return null;
    if (p !== null) return p;
    const r = draw(c.pack.seed, draws); draws += 1;
    if (fresh.length) return fresh.splice(Math.floor(r * fresh.length), 1)[0];
    return unused.length ? unused[Math.floor(r * unused.length)] : null;
  });
  // Fastest pick first (the database clock's order); the clock's picks last; level times go by a seat order that
  // rotates round by round.
  const n = picks.length;
  const turn = (seat: number) => (seat - s.round + n * (s.round + 1)) % n;
  const order = picks.map((_, seat) => seat).sort((a, b) => (s.pickedAt[a] ?? Infinity) - (s.pickedAt[b] ?? Infinity) || turn(a) - turn(b));
  const reveal: QueuedPick[] = order.flatMap((seat) => (picks[seat] ? [{ seat, stat: picks[seat]!, auto: auto[seat] }] : []));
  const next: FootballRaceState = { ...s, phase: 'reveal', picks, draws, reveal, revealed: [], revealIndex: 0, revealOpen: false, deadline: now + REVEAL_STEP_MS * SUSPENSE };
  return reveal.length ? next : closeRound(next, c, now);
}

/** The match ends now: the furthest nations still racing win (shared on a tie). */
function finish(s: FootballRaceState, endedBy: EndReason, now: number): FootballRaceState {
  const active = racing(s);
  const top = Math.max(...s.positions.map((p, i) => (active[i] ? p : -1)));
  const winners = s.positions.flatMap((p, i) => (active[i] && p === top ? [i] : []));
  return { ...s, phase: 'over', rounds: [...s.rounds, s.revealed], revealed: [], reveal: null, winners, endedBy, deadline: now };
}

function closeRound(s: FootballRaceState, c: FootballRaceContent, now: number): FootballRaceState {
  if (playableLeft(s, c).length === 0) return finish(s, 'stats', now);
  if (s.round + 1 >= MAX_ROUNDS) return finish(s, 'rounds', now);
  return openRound({ ...s, rounds: [...s.rounds, s.revealed], revealed: [] }, s.round + 1, now);
}

/** A queued pick opens: judged now, among the nations still racing; the step that reaches the line ends the match. */
function openPick(s: FootballRaceState, c: FootballRaceContent, now: number): FootballRaceState {
  const queued = (s.reveal ?? [])[s.revealIndex];
  const cmp = judge(s, c, queued.stat);
  const racers = racersOf(s);
  const stat = indexOf(dataOf(c)).statOf.get(queued.stat);
  const result: PickResult = { ...queued, values: cmp ? cmp.values : racers.map((r) => stat?.values[r] ?? 0), leaders: cmp ? cmp.leaders : [] };
  const positions = [...s.positions];
  for (const seat of result.leaders) positions[seat] += 1;
  const next: FootballRaceState = { ...s, positions, used: s.used.includes(queued.stat) ? s.used : [...s.used, queued.stat], revealed: [...s.revealed, result], revealOpen: true };
  if (result.leaders.some((seat) => positions[seat] >= targetFor(s.status.length))) return finish(next, 'line', now);
  const lastStep = s.revealIndex === (s.reveal ?? []).length - 1;
  return { ...next, deadline: now + REVEAL_STEP_MS * (1 - SUSPENSE) + (lastStep ? REVEAL_TAIL_MS : 0) };
}

export function tick(s: FootballRaceState, c: FootballRaceContent, now: number): FootballRaceState {
  if (ended(s) || now < s.deadline) return s;
  if (s.phase === 'draft') return autoNation(s, c.pack.seed, now);
  if (s.phase === 'intro') return openRound(s, 0, now);
  if (s.phase === 'pick') return settle(s, c, now);
  if (!s.revealOpen) return openPick(s, c, now);
  if (s.revealIndex + 1 < (s.reveal ?? []).length) return { ...s, revealIndex: s.revealIndex + 1, revealOpen: false, deadline: now + REVEAL_STEP_MS * SUSPENSE };
  return closeRound(s, c, now);
}

/** After an outage the open window (draft turn, intro, pick, reveal step) starts again. */
export function afterOutage(s: FootballRaceState, now: number): FootballRaceState {
  if (s.phase === 'draft') return { ...s, deadline: now + DRAFT_PICK_MS };
  if (s.phase === 'intro') return { ...s, deadline: now + INTRO_MS };
  if (s.phase === 'pick') return { ...s, deadline: now + PICK_MS };
  if (s.phase === 'reveal') return { ...s, deadline: now + REVEAL_STEP_MS * (s.revealOpen ? 1 - SUSPENSE : SUSPENSE) };
  return s;
}

/**
 * Seat changes that arrive together. A seat that leaves retires its nation for the rest of the race (and is given one
 * at once if the draft reaches it); fewer than two left ends the match: a result once a pick was shown, otherwise
 * cancelled. An away seat keeps its seat: its clock runs and a missing pick is drawn for it. When every seat that is
 * in has picked (after any change), the next tick closes the window at once.
 */
export function seatsChanged(s: FootballRaceState, changes: readonly RoomSeatChange[], now: number): FootballRaceState {
  if (ended(s)) return s;
  const status = [...s.status];
  const quit = [...s.quit];
  let left = false;
  for (const { seat, change } of changes) {
    if (status[seat] === 'withdrawn') continue;
    status[seat] = change === 'leave' ? 'withdrawn' : change === 'away' ? 'away' : 'in';
    if (change === 'leave') { left = true; quit[seat] = true; }
  }
  let next: FootballRaceState = { ...s, status, quit };
  if (left && status.filter((st) => st !== 'withdrawn').length < 2) {
    const shown = s.rounds.some((r) => r.length > 0) || s.revealed.length > 0;
    return shown ? finish(next, 'left', now) : { ...next, phase: 'cancelled', deadline: now };
  }
  if (next.phase === 'draft' && status[next.draftOrder[next.draftTurn]] === 'withdrawn') next = { ...next, deadline: now };
  if (next.phase === 'pick' && next.picks.every((p, i) => p !== null || status[i] !== 'in')) next = { ...next, deadline: now };
  return next;
}

export function applyCommand(s: FootballRaceState, c: FootballRaceContent, seat: number, command: FootballRaceCommand, now: number): { state: FootballRaceState; error?: CommandError } {
  if (s.status[seat] === 'withdrawn') return { state: s, error: 'withdrawn' };
  if (command.type === 'draft') {
    if (s.phase !== 'draft' || now >= s.deadline) return { state: s, error: 'not_open' };
    if (command.turn !== s.draftTurn) return { state: s, error: 'stale' };
    if (s.draftOrder[s.draftTurn] !== seat) return { state: s, error: 'not_your_turn' };
    const nation = s.racers.indexOf(command.nation);
    if (nation < 0 || s.nationOf.includes(nation)) return { state: s, error: 'taken' };
    return { state: takeNation(s, seat, nation, false, now) };
  }
  if (s.phase !== 'pick' || now >= s.deadline) return { state: s, error: 'not_open' };
  if (command.round !== s.round) return { state: s, error: 'stale' };
  if (s.picks[seat] !== null) return { state: s, error: 'already_picked' };
  if (!s.statIds.includes(command.stat)) return { state: s, error: 'unknown_stat' };
  if (s.used.includes(command.stat)) return { state: s, error: 'stat_used' };
  const data = dataOf(c);
  const stat = data.stats.find((x) => x.id === command.stat);
  if (!stat || !compare(stat, data.metrics.find((m) => m.id === stat.metric)!, racersOf(s), racing(s))) return { state: s, error: 'unknown_stat' };
  const picks = s.picks.map((p, i) => (i === seat ? command.stat : p));
  const next = { ...s, picks, pickedAt: s.pickedAt.map((t, i) => (i === seat ? now : t)) };
  return { state: picks.every((p, i) => p !== null || s.status[i] !== 'in') ? settle(next, c, now) : next };
}

/** Furthest first; places shared on ties; seats that left rank below everyone who stayed. `roundWins` = good calls. */
export function standings(s: FootballRaceState): RoomEngineStanding[] {
  const all = s.rounds.flat();
  const rows = s.positions.map((position, seat) => ({ seat, position, good: all.filter((r) => r.seat === seat && !r.auto && r.leaders.includes(seat)).length, quit: s.quit[seat] }));
  const stayed = rows.filter((r) => !r.quit);
  return rows
    .sort((a, b) => Number(a.quit) - Number(b.quit) || b.position - a.position || b.good - a.good || a.seat - b.seat)
    .map((r) => ({ seat: r.seat, points: r.position, roundWins: r.good, place: r.quit ? stayed.length + 1 : 1 + stayed.filter((o) => o.position > r.position).length }));
}

const tr = (text: L10n | undefined, locale: RoomLocale) => (text ? l10n(text, locale) : null);

/**
 * What a seat sees, built field by field. Stat wording for the whole tournament; values (and the match behind them)
 * only for picks already revealed. Another seat's pick is never sent before it is revealed, and the reveal's count is
 * the number of picks made, never the number that will be shown.
 */
export function viewOf(s: FootballRaceState, c: FootballRaceContent, seat: number, locale: RoomLocale) {
  const data = dataOf(c);
  const { nationOf, statOf, metricOf } = indexOf(data);
  const racers = racersOf(s);
  const shownIds = new Set([...s.rounds.flat(), ...s.revealed].map((r) => r.stat));
  const detailOf = (r: PickResult) => racers.map((id) => tr(statOf.get(r.stat)?.details?.[id], locale));
  const publicPick = (r: PickResult) => ({ ...r, details: detailOf(r) });
  const queued = s.phase === 'reveal' && s.reveal ? s.reveal[s.revealIndex] ?? null : null;
  const finale = s.phase === 'over' && s.endedBy === 'line' ? s.rounds.at(-1)?.at(-1) ?? null : null;
  const nationView = (id: string) => { const n = nationOf.get(id)!; return { id: n.id, code: n.code, flag: n.flag, name: l10n(n.name, locale) }; };
  const over = ended(s);
  return {
    phase: s.phase === 'cancelled' ? 'over' : s.phase,
    cancelled: s.phase === 'cancelled',
    format: s.status.length === 2 ? 'duel' : 'party',
    round: s.round,
    target: targetFor(s.status.length),
    tournament: { id: data.tournament.id, label: l10n(data.tournament.label, locale) },
    source: l10n(data.source, locale),
    cutoff: data.cutoff,
    eras: data.scopes.map((x) => ({ id: x.id, label: l10n(x.label, locale) })),
    families: data.families.map((f) => ({ id: f.id, label: l10n(f.label, locale) })),
    metrics: data.metrics.map((m) => ({ id: m.id, family: m.family, unwanted: m.unwanted, dir: m.dir, decimals: m.decimals, kind: m.kind, label: l10n(m.label, locale), keywords: m.keywords })),
    // Public facts only: the stats already shown, the one on the reveal card (its id is out), this seat's own pick, and
    // those that still split the nations racing (statuses are public). Later picks in the reveal are listed (or not) like
    // any stat nobody picked.
    stats: s.statIds.flatMap((id) => { const st = statOf.get(id); return st && (shownIds.has(id) || id === queued?.stat || (s.phase === 'pick' && id === s.picks[seat]) || compare(st, metricOf.get(st.metric)!, racers, racing(s))) ? [{ id, scope: st.scope, metric: st.metric, family: metricOf.get(st.metric)?.family ?? '', unwanted: metricOf.get(st.metric)?.unwanted ?? false }] : []; }),
    nations: s.racers.map(nationView),
    draft: { order: s.draftOrder, turn: s.phase === 'draft' ? s.draftTurn : null, picks: s.nationOf.map((i) => (i === null ? null : s.racers[i])), auto: s.draftAuto },
    seats: s.status.map((status, i) => ({ seat: i, status, nation: s.nationOf[i] === null ? null : s.racers[s.nationOf[i]!], position: s.positions[i], picked: s.phase === 'pick' && s.picks[i] !== null, quit: s.quit[i] })),
    mySeat: seat,
    myPick: s.phase === 'pick' ? s.picks[seat] : null,
    history: [...s.rounds.flat(), ...s.revealed].map(publicPick),
    reveal: queued ? {
      item: s.revealOpen ? publicPick(s.revealed[s.revealed.length - 1]) : { seat: queued.seat, stat: queued.stat, auto: queued.auto, values: [], leaders: [], details: [] },
      index: s.revealIndex, total: s.reveal!.length, open: s.revealOpen,
    } : null,
    /** The pick that put a nation on the line, for the screen to show before the result. */
    finale: finale ? publicPick(finale) : null,
    standings: s.phase === 'over' ? standings(s) : null,
    winners: s.phase === 'over' ? s.winners : null,
    endedBy: s.endedBy,
    deadline: over ? null : new Date(s.deadline).toISOString(),
  };
}
