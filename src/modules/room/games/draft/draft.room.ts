import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { RoomContentUnavailable } from '../../../footballers/footballers.russian.js';
import { activeRelease, draftEras, draftFormations, draftPacks } from '../../../draft/draft.content.js';
import { activeSeat, finish, newDraft, pick, signAcademy, slotsOf, timeoutPick, type DraftState } from '../../../draft/draft.engine.js';
import { maskId, type RunSetup } from '../../../draft/draft.run.js';
import { lines, pickOrder, pickSeconds, priceOf, wallet, type DraftPlayer, type FormationId, type MatchDay, type Pick, type SeasonResult, type Variant } from '../../../draft/draft.rules.js';
import type { ServerUniverse } from '../../../draft/draft.universe.js';
import type { RoomEngine, RoomEngineStanding, RoomEngineState, RoomSeatChange, RoomSeatStatus } from '../../room.engine.js';

export type DraftRoomOptions = { leagueId: string; era: (typeof draftEras)[number]; formation: FormationId; variant: Variant };
const DEFAULT_OPTIONS: DraftRoomOptions = { leagueId: 'pl', era: 'all', formation: '4-3-3', variant: 'budget' };
const optionsSchema = z.object({
  leagueId: z.string().min(1).max(20),
  era: z.enum(draftEras),
  formation: z.enum(draftFormations as [FormationId, ...FormationId[]]),
  variant: z.enum(['budget', 'classic', 'knowledge']),
}).strict();

export interface DraftRoomContent { setup: RunSetup; universe: ServerUniverse | null }
const contentSchema = z.object({ setup: z.object({ release: z.string(), leagueId: z.string(), era: z.enum(draftEras), formation: z.string(), variant: z.enum(['budget', 'classic', 'knowledge']), seed: z.string() }) });

type SeasonSummary = Pick2<SeasonResult, 'w' | 'd' | 'l' | 'gf' | 'ga' | 'points' | 'position' | 'finish' | 'games'>;
type Pick2<T, K extends keyof T> = { [P in K]: T[P] };

export interface DraftRoomState extends RoomEngineState {
  phase: 'picking' | 'over' | 'cancelled';
  seats: number;
  round: number;
  turn: number;
  firstSeat: number;
  spinId: string;
  spinCount: number;
  usedClubs: string[];
  taken: DraftState['taken'];
  feed: DraftState['feed'];
  picks: (Pick | null)[][];
  seasons: SeasonSummary[] | null;
  /** Two seats end in a tie. */
  tie: MatchDay | null;
  winner: number | null;
}

const WITHDRAWN_TURN_MS = 400;

export const draftRoomCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pick'), round: z.number().int().min(0).max(11), turn: z.number().int().min(0).max(8), playerId: z.string().min(1).max(100), slotId: z.string().max(10).optional() }).strict(),
  z.object({ type: z.literal('academy'), round: z.number().int().min(0).max(11), turn: z.number().int().min(0).max(8), slotId: z.string().min(1).max(10) }).strict(),
]);
export type DraftRoomCommand = z.infer<typeof draftRoomCommandSchema>;

const modeOf = (seats: number) => (seats === 2 ? 'duel' : 'room') as 'duel' | 'room';

function thaw(u: ServerUniverse, setup: RunSetup, st: DraftRoomState): DraftState {
  const base = newDraft(u, { mode: modeOf(st.seats), variant: setup.variant, leagueId: setup.leagueId, era: setup.era, formation: setup.formation as FormationId, seed: setup.seed, seats: Array.from({ length: st.seats }, (_, i) => ({ name: String(i), avatar: null, bot: false })) });
  const spin = u.clubSeason(st.spinId);
  if (!spin) throw new RoomContentUnavailable();
  return { ...base, spin, round: st.round, turn: st.turn, firstSeat: st.firstSeat, spinCount: st.spinCount, usedClubs: st.usedClubs, taken: st.taken, feed: st.feed, phase: 'picking', seats: base.seats.map((seat, i) => ({ ...seat, picks: st.picks[i] })) };
}

// Only a seat that has left is hurried past: someone away for a moment keeps a whole turn.
const turnMs = (st: { seats: number }, status: RoomSeatStatus) => (status === 'withdrawn' ? WITHDRAWN_TURN_MS : pickSeconds(st.seats) * 1000);

/** After every signing: the draft moved on, or it is over and the seasons are played. */
function carry(u: ServerUniverse, st: DraftRoomState, d: DraftState, nowMs: number): DraftRoomState {
  const next: DraftRoomState = { ...st, round: d.round, turn: d.turn, spinId: d.spin.id, spinCount: d.spinCount, usedClubs: d.usedClubs, taken: d.taken, feed: d.feed.slice(-12), picks: d.seats.map((s) => s.picks) };
  if (d.phase !== 'ready') return { ...next, deadline: nowMs + turnMs(st, st.status[activeSeat(d)]) };
  const done = finish(u, d);
  const seasons = done.seasons!.map(({ w, d: draws, l, gf, ga, points, position, finish: place, games }) => ({ w, d: draws, l, gf, ga, points, position, finish: place, games }));
  const order = done.seasons!.map((s, i) => ({ i, key: s.points * 1_000_000 + (s.gf - s.ga + 500) * 1000 + s.gf })).sort((a, b) => b.key - a.key);
  const tie = done.match ?? null;
  // Someone who left never wins: the best seat still in does.
  const stayed = order.filter((x) => st.status[x.i] !== 'withdrawn');
  const tieWinner = tie ? (st.status[tie.winner] === 'withdrawn' && st.status[1 - tie.winner] !== 'withdrawn' ? 1 - tie.winner : tie.winner) : null;
  return { ...next, phase: 'over', deadline: nowMs, seasons, tie, winner: tieWinner ?? stayed[0]?.i ?? order[0].i };
}

const uOf = (content: DraftRoomContent): ServerUniverse => {
  if (!content.universe) throw new RoomContentUnavailable();
  return content.universe;
};

function autoSign(content: DraftRoomContent, st: DraftRoomState, nowMs: number): DraftRoomState {
  const u = uOf(content);
  const d = thaw(u, content.setup, st);
  return carry(u, st, timeoutPick(u, d), nowMs);
}

const inCount = (status: RoomSeatStatus[]) => status.filter((s) => s !== 'withdrawn').length;

type PublicSquadPlayer = Omit<DraftPlayer, 'personId'> & { personId?: string; price?: number };

export const draftRoomEngine: RoomEngine<DraftRoomContent, DraftRoomState, DraftRoomCommand, DraftRoomOptions> = {
  game: 'draft',
  version: 1,
  commandSchema: draftRoomCommandSchema,

  parseContent(raw) {
    const parsed = contentSchema.safeParse(raw);
    return parsed.success ? { setup: parsed.data.setup as RunSetup, universe: null } : null;
  },

  parseOptions(raw) {
    if (raw === null || raw === undefined) return DEFAULT_OPTIONS;
    const parsed = optionsSchema.safeParse(raw);
    return parsed.success ? (parsed.data as DraftRoomOptions) : undefined;
  },

  /** Needs no pool rows: a fresh seed on the active release. Squads load here, before the match exists and outside any lock. */
  async deal(_pick, options) {
    const release = await activeRelease();
    const u = await draftPacks.get(release).catch(() => null);
    if (!u || !u.leagues.some((l) => l.id === options.leagueId) || !u.hasEra(options.leagueId, options.era)) return null;
    const setup: RunSetup = { ...options, release, seed: randomBytes(12).toString('hex') };
    return { itemIds: [], content: { setup } };
  },

  async hydrate(content, _state, tx) {
    if (content.universe) return content;
    if (tx) {
      const ready = draftPacks.ready(content.setup.release);
      if (!ready) throw new RoomContentUnavailable();
      return { ...content, universe: ready };
    }
    return { ...content, universe: await draftPacks.get(content.setup.release) };
  },

  start(seats, content, nowMs) {
    const u = uOf(content);
    const d = newDraft(u, { mode: modeOf(seats), variant: content.setup.variant, leagueId: content.setup.leagueId, era: content.setup.era, formation: content.setup.formation, seed: content.setup.seed, seats: Array.from({ length: seats }, (_, i) => ({ name: String(i), avatar: null, bot: false })) });
    return {
      deadline: nowMs + pickSeconds(seats) * 1000, status: Array.from({ length: seats }, () => 'in' as RoomSeatStatus), phase: 'picking', seats, round: 0, turn: 0, firstSeat: d.firstSeat, spinId: d.spin.id,
      spinCount: d.spinCount, usedClubs: d.usedClubs, taken: [], feed: [], picks: d.seats.map((s) => s.picks), seasons: null, tie: null, winner: null,
    };
  },

  tick(state, content, nowMs) {
    if (state.phase !== 'picking' || nowMs < state.deadline) return state;
    return autoSign(content, state, nowMs);
  },

  afterOutage(state, _content, nowMs) {
    return state.phase === 'picking' ? { ...state, deadline: nowMs + pickSeconds(state.seats) * 1000 } : state;
  },

  seatsChanged(state, changes: readonly RoomSeatChange[], nowMs) {
    const status = state.status.slice();
    for (const c of changes) status[c.seat] = c.change === 'leave' ? 'withdrawn' : c.change === 'away' ? 'away' : 'in';
    if (state.phase !== 'picking') return { ...state, status };
    if (inCount(status) === 0) return { ...state, status, phase: 'cancelled', deadline: nowMs };
    // The seat on the clock left for good: its turn ends now. Someone only away keeps the clock they had.
    const onClock = pickOrder(state.round + state.firstSeat, state.seats)[state.turn];
    return { ...state, status, deadline: status[onClock] === 'withdrawn' ? Math.min(state.deadline, nowMs + WITHDRAWN_TURN_MS) : state.deadline };
  },

  apply(state, content, seat, command, nowMs) {
    if (state.phase !== 'picking') return { state, error: 'match_over' };
    if (state.status[seat] === 'withdrawn') return { state, error: 'left_match' };
    if (command.round !== state.round || command.turn !== state.turn) return { state, error: 'stale_turn' };
    const u = uOf(content);
    const d = thaw(u, content.setup, state);
    if (activeSeat(d) !== seat) return { state, error: 'not_your_turn' };
    if (command.type === 'academy') {
      const next = signAcademy(u, d, command.slotId);
      return next === d ? { state, error: 'invalid_pick' } : { state: carry(u, state, next, nowMs) };
    }
    const player = content.setup.variant === 'knowledge' ? d.spin.players.find((p) => maskId(content.setup.seed, p.id) === command.playerId) : d.spin.players.find((p) => p.id === command.playerId);
    if (!player) return { state, error: 'invalid_pick' };
    const next = pick(u, d, player.id, command.slotId);
    return next === d ? { state, error: 'invalid_pick' } : { state: carry(u, state, next, nowMs) };
  },

  terminal: (state) => (state.phase === 'over' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : null),

  standings(state) {
    const seats = Array.from({ length: state.seats }, (_, seat) => seat);
    if (!state.seasons) return seats.map((seat): RoomEngineStanding => ({ seat, points: 0, roundWins: 0, place: 1 }));
    const key = (seat: number) => { const s = state.seasons![seat]; return s.points * 1_000_000 + (s.gf - s.ga + 500) * 1000 + s.gf; };
    const left = (seat: number) => state.status[seat] === 'withdrawn';
    const order = seats.slice().sort((a, b) => Number(left(a)) - Number(left(b)) || (state.tie ? (a === state.winner ? -1 : b === state.winner ? 1 : 0) : key(b) - key(a)));
    return order.map((seat, i): RoomEngineStanding => ({ seat, points: state.seasons![seat].points, roundWins: 0, place: i + 1 }));
  },

  view(state, content, seat) {
    const u = uOf(content);
    const { setup } = content;
    const hidden = setup.variant === 'knowledge' && state.phase === 'picking';
    const budget = setup.variant === 'budget';
    const showPlayer = (p: DraftPlayer): PublicSquadPlayer => (hidden
      ? { id: maskId(setup.seed, p.id), personId: maskId(setup.seed, p.personId ?? p.id), name: p.name, pos: p.pos, alt: p.alt, role: p.role, rating: 0, apps: 0, goals: 0, assists: null, cleanSheets: 0, minutesShare: 0 }
      : { ...p, ...(budget ? { price: priceOf(p) } : {}) });
    const showPick = (p: Pick | null) => {
      if (!p) return null;
      const { best: _best, ...rest } = p;
      return { ...rest, player: p.academy ? p.player : showPlayer(p.player) };
    };
    const d = state.phase === 'picking' ? thaw(u, setup, state) : null;
    const league = u.leagues.find((l) => l.id === setup.leagueId) ?? u.leagues[0];
    const squad = d ? d.spin.players.map(showPlayer) : [];
    return {
      phase: state.phase, seats: state.seats, you: seat, round: state.round, turn: state.turn, activeSeat: d ? activeSeat(d) : null, deadline: state.deadline, status: state.status,
      variant: setup.variant, era: setup.era, formation: setup.formation, budget: budget ? (d?.budget ?? null) : null,
      league: { id: league.id, name: league.name, short: league.short, teams: league.teams, games: league.games },
      spin: d ? { id: hidden ? maskId(setup.seed, d.spin.id) : d.spin.id, club: d.spin.club, season: d.spin.season, legend: d.spin.legend, finish: hidden ? 0 : d.spin.finish, players: hidden ? squad.slice().sort((a, b) => a.name.localeCompare(b.name)) : squad } : null,
      taken: state.taken.map((t) => ({ playerId: hidden ? maskId(setup.seed, t.playerId) : t.playerId, seat: t.seat })),
      feed: state.feed, picks: state.picks.map((row) => row.map(showPick)), spent: budget ? state.picks.map((row) => wallet(row, d?.budget).left) : null,
      seasons: state.seasons, tie: state.tie, winner: state.winner,
      lines: state.phase === 'over' ? state.picks.map((row) => lines(slotsOf({ formation: setup.formation } as DraftState), row).overall) : null,
    };
  },
};
