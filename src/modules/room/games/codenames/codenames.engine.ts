import { z } from 'zod';
import type { RoomEngineStanding, RoomEngineState, RoomSeatChange } from '../../room.engine.js';
import type { RoomLocale } from '../../room.types.js';
import {
  bestClue, clueProblem, clueTargets, fold, isWordsPack, MAX_BOARD_SIZE, MAX_CLUE_CHARS, MAX_CLUE_COUNT, other, rng, shuffled, teamKey, termLabel, termSpellings, tidyClue,
  type CardKey, type ClueProblem, type CodenamesPack, type Team, type Term,
} from './codenames.rules.js';

/**
 * Football Codenames as a room game (2–8 seats), pure: time comes in as `now` (the database clock read under the
 * match lock); every random draw comes from the pack's seed and a counter kept in the state.
 *
 * 1. Teams: everyone arrives without a side and picks Home or Away, as Scout or guesser; the host can shuffle and
 *    kicks off. At kick-off, anyone still without a side joins the smaller team; a team without a human Scout (or
 *    whose only player chose Scout) gets the bot Scout, so two players can play one against one.
 * 2. Turns: the Scout gives a clue and a number; the team's guessers flip cards, up to number + 1. Their own card lets
 *    them go on; a neutral or rival card ends the turn; the Own Goal loses the game. A team wins when all its cards
 *    are revealed (whoever flipped the last one) or when the rivals have nobody left.
 *
 * Without a turn timer the game shows no clock. Every phase still has a deadline, so a room never stalls: the bot gives
 * the clue for a Scout who is gone or idle, an idle turn ends, and the teams screen kicks off by itself. With a timer
 * (the host's pick, stored with the board) the Scout has that long for the clue and the team as long for its guesses:
 * a Scout who runs out passes the turn, a team that runs out ends it.
 */
export const MAX_SEATS = 8;
export const TEAMS_MS = 4 * 60_000;
export const BOT_CLUE_MS = 2_500;
export const CLUE_IDLE_MS = 5 * 60_000;
export const AWAY_SCOUT_MS = 20_000;
export const GUESS_IDLE_MS = 5 * 60_000;
/** Turns in a row in which no player did anything: the room is abandoned, the game ends without a winner. */
export const MAX_IDLE_TURNS = 4;
/** A slow game: a phone that sleeps through a teammate's long think keeps its seat. */
export const ABSENCE = { awayMs: 3 * 60_000, budgetMs: 10 * 60_000 };

/** The stored pack (the board and its key); nothing else is needed to play. */
export type CodenamesContent = CodenamesPack;

/** Bounded by the largest board; `applyCommand` checks it against this match's board. */
const cardIndex = z.number().int().min(0).max(MAX_BOARD_SIZE - 1);
const team = z.union([z.literal(0), z.literal(1)]);
const turnNo = z.number().int().min(0).max(500);
/** `turn`: the turn the command is for (from the view), so a late or repeated send never lands in the next turn. */
export const codenamesCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('join'), team, scout: z.boolean() }).strict(),
  /** `seen`: the shuffles the sender's screen showed (the client knows its shuffle was judged once the count passes it). */
  z.object({ type: z.literal('shuffle'), seen: z.number().int().min(0).max(1_000).optional() }).strict(),
  z.object({ type: z.literal('kickoff') }).strict(),
  /** `cards`: the Scout's own cards the clue is meant for (optional; when given, as many as `count`), shown when the game ends. */
  z.object({ type: z.literal('clue'), turn: turnNo, word: z.string().max(MAX_CLUE_CHARS * 4), count: z.number().int().min(1).max(MAX_CLUE_COUNT), cards: z.array(cardIndex).min(1).max(MAX_CLUE_COUNT).optional() }).strict(),
  /** `n`: the sender's own counter, so pointing back at a card is a new command, not a repeat of the first. */
  z.object({ type: z.literal('point'), turn: turnNo, card: cardIndex.nullable(), n: z.number().int().min(0).max(100_000).optional() }).strict(),
  z.object({ type: z.literal('flip'), turn: turnNo, card: cardIndex }).strict(),
  z.object({ type: z.literal('endTurn'), turn: turnNo }).strict(),
]);
export type CodenamesCommand = z.infer<typeof codenamesCommandSchema>;

export type Phase = 'teams' | 'clue' | 'guess' | 'over' | 'cancelled';
export type EndReason = 'cleared' | 'owngoal' | 'left' | 'idle';

/** A clue as said: a Scout's own words, or the bot's name from the cards (shown in each reader's language). */
export interface GivenClue { word: string | null; term: Term | null; count: number; bot: boolean }
export interface Flip { card: number; key: CardKey; seat: number }
/**
 * `clue` null: the bot had no safe clue left and passed, or (`timeout`) the Scout ran out of time. `meant`: the cards the
 * clue was given for (the bot's, or the ones a Scout marked), private until the game is over.
 */
export interface Turn { team: Team; clue: GivenClue | null; flips: Flip[]; meant?: number[]; timeout?: true }

export interface CodenamesState extends RoomEngineState {
  phase: Phase;
  host: number;
  team: Array<Team | null>;
  /** On the teams screen: who asked to be Scout. In play: the team's human Scout (one at most). */
  scout: boolean[];
  /** Seats that have seen the key (human Scouts in play): they never guess on this board. */
  sawKey: boolean[];
  /** Per team: the bot gives the clues (no human Scout). */
  botScout: [boolean, boolean];
  starting: Team;
  turn: Team;
  /** Turns started so far; the current one's number (commands carry it). */
  turnNo: number;
  revealed: Array<CardKey | null>;
  /** The card each seat is pointing at (its teammates see it). */
  pointing: Array<number | null>;
  clue: GivenClue | null;
  guessesLeft: number;
  history: Turn[];
  /** Folded spellings said this game: no clue twice. */
  used: string[];
  /** A player gave the clue, flipped or ended this turn. */
  acted: boolean;
  idleTurns: number;
  winner: Team | null;
  endedBy: EndReason | null;
  draws: number;
  /** Turn timer in ms (the Scout's clue, then the team's guesses); null or absent (a match from before timers): none. */
  timer?: number | null;
  /** With a timer: when the human Scout's time for this clue runs out, however often they leave and come back. */
  clueEndsAt?: number | null;
}

export type CommandError = ClueProblem | 'not_open' | 'stale' | 'withdrawn' | 'not_host' | 'not_your_turn' | 'not_scout' | 'not_guesser' | 'revealed' | 'need_teams' | 'no_flip' | 'no_card' | 'bad_cards';

const fill = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);
const ended = (s: CodenamesState) => s.phase === 'over' || s.phase === 'cancelled';
const inPlay = (s: CodenamesState) => s.phase === 'clue' || s.phase === 'guess';
const present = (s: CodenamesState, seat: number) => s.status[seat] !== 'withdrawn';
const membersOf = (s: CodenamesState, t: Team) => s.team.flatMap((x, seat) => (x === t && present(s, seat) ? [seat] : []));
const humanScoutOf = (s: CodenamesState, t: Team) => (s.botScout[t] ? null : membersOf(s, t).find((seat) => s.scout[seat]) ?? null);
const guessersOf = (s: CodenamesState, t: Team) => membersOf(s, t).filter((seat) => !s.scout[seat] && !s.sawKey[seat]);
const draw = (seed: number, n: number) => rng((seed ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0);

export function startMatch(seats: number, pack: CodenamesContent, now: number, hostSeat: number | null = null): CodenamesState {
  if (seats < 2 || seats > MAX_SEATS) throw new Error(`A Football Codenames room needs 2 to ${MAX_SEATS} admitted seats`);
  return {
    phase: 'teams', deadline: now + TEAMS_MS, status: fill(seats, 'in'), host: hostSeat !== null && hostSeat < seats ? hostSeat : 0,
    team: fill<Team | null>(seats, null), scout: fill(seats, false), sawKey: fill(seats, false), botScout: [false, false],
    starting: pack.starting, turn: pack.starting, turnNo: 0, revealed: fill<CardKey | null>(pack.cards.length, null), pointing: fill<number | null>(seats, null),
    clue: null, guessesLeft: 0, history: [], used: [], acted: false, idleTurns: 0, winner: null, endedBy: null, draws: 0,
    timer: pack.timer ? pack.timer * 1_000 : null,
  };
}

// ---------------------------------------------------------------- teams

function join(s: CodenamesState, seat: number, t: Team, asScout: boolean): CodenamesState {
  const teamOf = s.team.map((x, i) => (i === seat ? t : x));
  // One Scout per team: a new one sends the old one back to the guessers.
  const scout = s.scout.map((x, i) => (i === seat ? asScout : asScout && teamOf[i] === t ? false : x));
  return { ...s, team: teamOf, scout };
}

/** Random even sides; a side of two or more gets a Scout. */
function shuffleTeams(s: CodenamesState, seed: number): CodenamesState {
  const seats = shuffled(s.status.flatMap((_, seat) => (present(s, seat) ? [seat] : [])), draw(seed, s.draws));
  const teamOf = [...s.team];
  const scout = fill(s.status.length, false);
  const firstSide: Team = draw(seed, s.draws + 1)() < 0.5 ? 0 : 1;
  seats.forEach((seat, i) => { teamOf[seat] = i % 2 === 0 ? firstSide : other(firstSide); });
  for (const t of [0, 1] as const) {
    const side = seats.filter((seat) => teamOf[seat] === t);
    if (side.length >= 2) scout[side[0]] = true;
  }
  return { ...s, team: teamOf, scout, draws: s.draws + 2 };
}

/** Everyone without a side joins the smaller team (Home on a tie), in seat order. */
function seatEveryone(s: CodenamesState): CodenamesState {
  const teamOf = [...s.team];
  for (let seat = 0; seat < teamOf.length; seat += 1) {
    if (teamOf[seat] !== null || !present(s, seat)) continue;
    const size = (t: Team) => teamOf.filter((x, i) => x === t && present(s, i)).length;
    teamOf[seat] = size(1) < size(0) ? 1 : 0;
  }
  return { ...s, team: teamOf };
}

/** Who gives the clues: a human Scout needs a teammate to guess, otherwise the bot does it and the human guesses. */
function settleScouts(s: CodenamesState): CodenamesState {
  const scout = s.scout.map((x, seat) => x && present(s, seat));
  const sawKey = [...s.sawKey];
  const botScout: [boolean, boolean] = [true, true];
  for (const t of [0, 1] as const) {
    const members = membersOf(s, t);
    const human = members.find((seat) => scout[seat]);
    if (human !== undefined && members.length >= 2) {
      botScout[t] = false;
      sawKey[human] = true;
    } else {
      for (const seat of members) scout[seat] = false;
    }
  }
  return { ...s, scout, sawKey, botScout };
}

function kickoff(s: CodenamesState, c: CodenamesContent, now: number): CodenamesState | null {
  const seated = settleScouts(seatEveryone(s));
  if (membersOf(seated, 0).length === 0 || membersOf(seated, 1).length === 0) return null;
  return openClue({ ...seated, turn: c.starting, turnNo: 0 }, now);
}

// ---------------------------------------------------------------- turns

const clueMs = (s: CodenamesState) => s.timer || CLUE_IDLE_MS;
const guessMs = (s: CodenamesState) => s.timer || GUESS_IDLE_MS;

function openClue(s: CodenamesState, now: number): CodenamesState {
  const human = humanScoutOf(s, s.turn);
  const wait = human === null ? BOT_CLUE_MS : s.status[human] === 'in' ? clueMs(s) : AWAY_SCOUT_MS;
  const clueEndsAt = s.timer && human !== null ? now + s.timer : null;
  return { ...s, clueEndsAt, phase: 'clue', clue: null, guessesLeft: 0, acted: false, pointing: s.pointing.map(() => null), deadline: now + wait };
}

function giveClue(s: CodenamesState, clue: GivenClue, meant: number[] | undefined, now: number): CodenamesState {
  const spellings = clue.term ? termSpellings(clue.term) : [fold(clue.word ?? '')];
  return {
    ...s, phase: 'guess', clue, guessesLeft: clue.count + 1, acted: s.acted || !clue.bot, used: [...new Set([...s.used, ...spellings])],
    history: [...s.history, { team: s.turn, clue, flips: [], ...(meant?.length ? { meant } : {}) }], deadline: now + guessMs(s),
  };
}

/**
 * The bot's clue for the team on turn: never a name said before, never one that also points at the hidden Own Goal.
 * With no such name left it passes the turn.
 */
function botClue(s: CodenamesState, c: CodenamesContent, now: number): CodenamesState {
  const pick = bestClue(c, s.revealed, s.turn, new Set(s.used));
  if (pick) return giveClue(s, { word: null, term: pick.term, count: pick.count, bot: true }, clueTargets(c, s.revealed, s.turn, pick.term), now);
  return endTurn({ ...s, history: [...s.history, { team: s.turn, clue: null, flips: [] }] }, now);
}

function cleared(s: CodenamesState, c: CodenamesContent, t: Team): boolean {
  return c.cards.every((card, i) => card.key !== teamKey(t) || s.revealed[i] !== null);
}

function finish(s: CodenamesState, winner: Team, endedBy: EndReason, now: number): CodenamesState {
  return { ...s, phase: 'over', winner, endedBy, clue: null, pointing: s.pointing.map(() => null), deadline: now };
}

const cancel = (s: CodenamesState, now: number): CodenamesState => ({ ...s, phase: 'cancelled', clue: null, pointing: s.pointing.map(() => null), deadline: now });

function endTurn(s: CodenamesState, now: number): CodenamesState {
  const idleTurns = s.acted ? 0 : s.idleTurns + 1;
  if (idleTurns >= MAX_IDLE_TURNS) return { ...cancel({ ...s, idleTurns }, now), endedBy: 'idle' };
  return openClue({ ...s, idleTurns, turn: other(s.turn), turnNo: s.turnNo + 1 }, now);
}

function flip(s: CodenamesState, c: CodenamesContent, seat: number, card: number, now: number): CodenamesState {
  const key = c.cards[card].key;
  const revealed = s.revealed.map((k, i) => (i === card ? key : k));
  const history = s.history.map((t, i) => (i === s.history.length - 1 ? { ...t, flips: [...t.flips, { card, key, seat }] } : t));
  const next: CodenamesState = { ...s, revealed, history, acted: true, pointing: s.pointing.map((p) => (p === card ? null : p)) };
  if (key === 'owngoal') return finish(next, other(s.turn), 'owngoal', now);
  for (const t of [s.turn, other(s.turn)] as const) if (cleared(next, c, t)) return finish(next, t, 'cleared', now);
  if (key !== teamKey(s.turn) || s.guessesLeft <= 1) return endTurn(next, now);
  // A turn timer runs for the whole guessing; without one each flip starts the idle wait again.
  return { ...next, guessesLeft: s.guessesLeft - 1, deadline: s.timer ? s.deadline : now + GUESS_IDLE_MS };
}

export function tick(s: CodenamesState, c: CodenamesContent, now: number): CodenamesState {
  if (ended(s) || now < s.deadline) return s;
  if (s.phase === 'teams') return kickoff(s, c, now) ?? cancel(s, now);
  if (s.phase === 'clue') {
    // Out of time with the Scout here: the turn passes (a Scout who is away gets the bot's clue instead).
    const human = humanScoutOf(s, s.turn);
    if (s.timer && human !== null && s.status[human] === 'in') return endTurn({ ...s, history: [...s.history, { team: s.turn, clue: null, flips: [], timeout: true }] }, now);
    return botClue(s, c, now);
  }
  return endTurn(s, now);
}

/** After an outage the open phase starts its wait again. */
export function afterOutage(s: CodenamesState, _c: CodenamesContent, now: number): CodenamesState {
  if (s.phase === 'teams') return { ...s, deadline: now + TEAMS_MS };
  if (s.phase === 'clue') return openClue({ ...s, acted: s.acted }, now);
  if (s.phase === 'guess') return { ...s, deadline: now + guessMs(s) };
  return s;
}

/**
 * After a seat leaves mid-game: a team whose human Scout left hands the clues to a teammate when two or more can still
 * guess (the new Scout sees the key from then on), otherwise to the bot. A team with nobody left who may guess (only
 * its Scout, who has seen the key) is out: the other team wins, unless nobody of it is here either (every tab closed);
 * both out at once ends the game without a winner.
 */
function regroup(s: CodenamesState, now: number): CodenamesState {
  const scout = s.scout.map((x, seat) => x && present(s, seat));
  const sawKey = [...s.sawKey];
  const botScout: [boolean, boolean] = [s.botScout[0], s.botScout[1]];
  for (const t of [0, 1] as const) {
    if (botScout[t] || membersOf(s, t).some((seat) => scout[seat])) continue;
    const eligible = membersOf(s, t).filter((seat) => !sawKey[seat]);
    if (eligible.length >= 2) {
      const next = eligible.find((seat) => s.status[seat] === 'in') ?? eligible[0];
      scout[next] = true;
      sawKey[next] = true;
    } else {
      botScout[t] = true;
    }
  }
  const next: CodenamesState = { ...s, scout, sawKey, botScout };
  const out = ([0, 1] as const).filter((t) => guessersOf(next, t).length === 0);
  if (out.length === 2) return cancel(next, now);
  if (out.length === 1) {
    // Nobody of the other team is here either (every tab closed): no one to hand a win to.
    const here = membersOf(next, other(out[0])).some((seat) => next.status[seat] === 'in');
    return here ? finish(next, other(out[0]), 'left', now) : cancel(next, now);
  }
  const scoutChanged = botScout[s.turn] !== s.botScout[s.turn] || humanScoutOf(next, s.turn) !== humanScoutOf(s, s.turn);
  return next.phase === 'clue' && scoutChanged ? openClue({ ...next }, now) : next;
}

/**
 * Seat changes that arrive together. On the teams screen a seat that leaves just loses its side (fewer than two left
 * cancels). In play see `regroup`. A Scout who is away gets a short wait before the bot gives that turn's clue.
 */
export function seatsChanged(s: CodenamesState, changes: readonly RoomSeatChange[], now: number): CodenamesState {
  if (ended(s)) return s;
  const status = [...s.status];
  let left = false;
  for (const { seat, change } of changes) {
    if (status[seat] === 'withdrawn') continue;
    status[seat] = change === 'leave' ? 'withdrawn' : change === 'away' ? 'away' : 'in';
    if (change === 'leave') left = true;
  }
  let next: CodenamesState = { ...s, status };
  if (left) {
    next = { ...next, pointing: next.pointing.map((p, seat) => (status[seat] === 'withdrawn' ? null : p)) };
    if (status[next.host] === 'withdrawn') {
      const firstIn = status.findIndex((st) => st === 'in');
      next = { ...next, host: firstIn >= 0 ? firstIn : Math.max(0, status.findIndex((st) => st !== 'withdrawn')) };
    }
  }
  if (next.phase === 'teams') {
    if (status.filter((st) => st !== 'withdrawn').length < 2) return cancel(next, now);
    return { ...next, team: next.team.map((t, seat) => (status[seat] === 'withdrawn' ? null : t)), scout: next.scout.map((x, seat) => x && status[seat] !== 'withdrawn') };
  }
  if (left) {
    next = regroup(next, now);
    if (ended(next)) return next;
  }
  if (next.phase === 'clue') {
    const human = humanScoutOf(next, next.turn);
    if (human !== null && status[human] === 'away') next = { ...next, deadline: Math.min(next.deadline, now + AWAY_SCOUT_MS) };
    // Back before the bot spoke: the Scout gets the whole wait again (the away one was shortened); with a timer, only
    // what is left of their time (coming back never adds to it).
    if (human !== null && status[human] === 'in' && s.status[human] === 'away') {
      next = { ...next, deadline: Math.max(next.deadline, next.timer && next.clueEndsAt ? next.clueEndsAt : now + CLUE_IDLE_MS) };
    }
  }
  return next;
}

export function applyCommand(s: CodenamesState, c: CodenamesContent, seat: number, command: CodenamesCommand, now: number): { state: CodenamesState; error?: CommandError } {
  if (s.status[seat] === 'withdrawn') return { state: s, error: 'withdrawn' };
  if (ended(s)) return { state: s, error: 'not_open' };
  switch (command.type) {
    case 'join':
      if (s.phase !== 'teams') return { state: s, error: 'not_open' };
      return { state: join(s, seat, command.team, command.scout) };
    case 'shuffle':
      if (s.phase !== 'teams') return { state: s, error: 'not_open' };
      if (seat !== s.host) return { state: s, error: 'not_host' };
      return { state: shuffleTeams(s, c.seed) };
    case 'kickoff': {
      if (s.phase !== 'teams') return { state: s, error: 'not_open' };
      if (seat !== s.host) return { state: s, error: 'not_host' };
      const next = kickoff(s, c, now);
      return next ? { state: next } : { state: s, error: 'need_teams' };
    }
    default:
      break;
  }
  if (command.turn !== s.turnNo) return { state: s, error: 'stale' };
  if (s.team[seat] !== s.turn) return { state: s, error: 'not_your_turn' };
  if (command.type === 'clue') {
    if (s.phase !== 'clue') return { state: s, error: 'not_open' };
    if (humanScoutOf(s, s.turn) !== seat) return { state: s, error: 'not_scout' };
    const problem = clueProblem(command.word, new Set(s.used), hiddenWords(s, c));
    if (problem) return { state: s, error: problem };
    const meant = command.cards;
    if (meant && (meant.length !== command.count || new Set(meant).size !== meant.length
      || meant.some((i) => i >= c.cards.length || s.revealed[i] !== null || c.cards[i].key !== teamKey(s.turn)))) return { state: s, error: 'bad_cards' };
    return { state: giveClue(s, { word: tidyClue(command.word), term: null, count: command.count, bot: false }, meant, now) };
  }
  if (s.phase !== 'guess') return { state: s, error: 'not_open' };
  if (!guessersOf(s, s.turn).includes(seat)) return { state: s, error: 'not_guesser' };
  const card = command.type === 'endTurn' ? null : command.card;
  if (card !== null && card >= c.cards.length) return { state: s, error: 'no_card' };
  if (command.type === 'point') {
    if (command.card !== null && s.revealed[command.card] !== null) return { state: s, error: 'revealed' };
    return { state: { ...s, pointing: s.pointing.map((p, i) => (i === seat ? command.card : p)) } };
  }
  if (command.type === 'flip') {
    if (s.revealed[command.card] !== null) return { state: s, error: 'revealed' };
    return { state: flip(s, c, seat, command.card, now) };
  }
  if ((s.history.at(-1)?.flips.length ?? 0) === 0) return { state: s, error: 'no_flip' };
  return { state: endTurn({ ...s, acted: true }, now) };
}

/** The winning team shares first place; `roundWins` = the seat's own flips of its team's cards. */
export function standings(s: CodenamesState): RoomEngineStanding[] {
  const flips = s.history.flatMap((t) => t.flips.map((f) => ({ ...f, team: t.team })));
  return s.status.map((_, seat) => {
    const won = s.winner !== null && s.team[seat] === s.winner;
    return { seat, points: won ? 1 : 0, roundWins: flips.filter((f) => f.seat === seat && f.key === teamKey(f.team)).length, place: won || s.winner === null ? 1 : 2 };
  });
}

/** The words still hidden on a word board (none on a picture board). */
const hiddenWords = (s: CodenamesState, c: CodenamesContent): string[] =>
  (isWordsPack(c) ? c.cards.flatMap((card, i) => (s.revealed[i] === null ? [card.word] : [])) : []);

/** The clue phase counts down the turn timer only while the team's human Scout is here to give it. */
const clueClock = (s: CodenamesState) => {
  const human = humanScoutOf(s, s.turn);
  return human !== null && s.status[human] === 'in';
};

const clueView = (clue: GivenClue, locale: RoomLocale) => ({ word: clue.term ? termLabel(clue.term, locale) : clue.word ?? '', count: clue.count, bot: clue.bot });

/**
 * What a seat sees. The key goes only to a human Scout during play, and to everyone once the game is over; the
 * names behind the bot's clues (which cards it meant) never leave the server. Pointing is shown to the pointer's team.
 */
export function viewOf(s: CodenamesState, c: CodenamesContent, seat: number, locale: RoomLocale) {
  const myTeam = s.team[seat];
  const iAmScout = inPlay(s) && myTeam !== null && humanScoutOf(s, myTeam) === seat;
  const revealMeant = s.phase === 'over' || (s.phase === 'cancelled' && s.history.length > 0);
  const showKeys = iAmScout || revealMeant;
  return {
    phase: s.phase === 'cancelled' ? 'over' : s.phase,
    cancelled: s.phase === 'cancelled',
    /** Why a game ended without a winner: nobody did anything for turns, or too few players were left. */
    cancelReason: s.phase !== 'cancelled' ? null : s.endedBy === 'idle' ? 'idle' : 'players',
    mySeat: seat,
    host: s.host,
    players: s.status.map((status, i) => ({ seat: i, status, team: s.team[i], scout: s.scout[i], sawKey: s.sawKey[i] })),
    botScout: s.phase === 'teams' ? [false, false] : s.botScout,
    starting: s.starting,
    turn: s.turn,
    turnNo: s.turnNo,
    /** Team shuffles so far (two draws each). */
    shuffles: s.draws / 2,
    /** Word boards only (a picture board's view is unchanged): the board kind and its language. */
    ...(isWordsPack(c) ? { board: 'words' as const, lang: c.lang } : {}),
    cards: c.cards.map((card, i) => ({
      id: card.id,
      ...('word' in card ? { word: card.word } : {}),
      revealed: s.revealed[i],
      key: showKeys ? card.key : null,
      picks: s.pointing.flatMap((p, pSeat) => (p === i && myTeam !== null && s.team[pSeat] === myTeam ? [pSeat] : [])),
    })),
    clue: s.phase === 'guess' && s.clue ? clueView(s.clue, locale) : null,
    guessesLeft: s.phase === 'guess' ? s.guessesLeft : null,
    /** The turn timer in seconds (null: none), and when the running one ends (epoch ms on the server clock; null: no clock now). */
    timer: s.timer ? s.timer / 1_000 : null,
    clockEndsAt: s.timer && (s.phase === 'guess' || (s.phase === 'clue' && clueClock(s))) ? s.deadline : null,
    // What each clue was meant for stays on the server until the game is over (a rival Scout's marks tell about the key).
    history: s.history.map((t) => ({ team: t.team, clue: t.clue ? clueView(t.clue, locale) : null, flips: t.flips, ...(t.timeout ? { timeout: true } : {}), ...(revealMeant ? { meant: t.meant ?? null } : {}) })),
    /** Every spelling said so far, folded, so the clue form can strike a name before it is sent. */
    used: s.used,
    result: s.phase === 'over' && s.winner !== null && s.endedBy ? { winner: s.winner, reason: s.endedBy } : null,
    standings: s.phase === 'over' ? standings(s) : null,
  };
}
