// COPY of the web's src/features/zone-match/zoneMatch.machine.ts (one rules implementation; keep byte-identical apart from import paths).
/**
 * Zone match prototype state machine: playstyles → each side's 5 random categories → ten possession rounds (one
 * continuous match; the attacker picks one of their categories at the start of each attack) → full time.
 * Timed transitions arrive as ADVANCE actions from the screen's clock; both players act through the same actions
 * (the scripted opponent included), so the rules apply to both sides alike.
 */

import type { GameQuestion } from './gameQuestion.js';
import { decideNumericDuel, type DuelGuess, type DuelReason, type DuelSide } from './numericDuel.js';
import { rand } from './zoneMatch.random.js';
import { MATCH_ROUNDS, otherZoneSide, pitchLabel, resolveBattle, type BattleOutcome, type Possession } from './zoneMatch.rules.js';
import {
  CARD_BY_ID,
  TIKI_TAKA_DUELS,
  completeDeck,
  legalDeck,
  decideDuel,
  movementMods,
  roleAllows,
  type ActiveCards,
  type CardId,
  type CardPhase,
  BLUFF_CARDS,
  BLUFF_FAKES,
} from './zoneMatch.cards.js';
import { revealSchedule } from './zoneMatch.reveal.js';
import { ENERGY_MAX, ENERGY_START, RULES } from './zoneMatch.playtest.js';
import { answerPoints, nextShooter, resolveKick, shootoutGoals, shootoutWinner, type Kick } from './zoneMatch.shootout.js';

// ── Timings ──────────────────────────────────────────────────────────────────

/** The live ShowdownScreen's own runtime. */
export const SHOWDOWN_MS = 4500;
/** After the VS screen, the showdown shows both decks so each player knows what the other can play: its length is the
 *  reveal's schedule (zoneMatch.reveal — every card's reaction in turn, then time to read). */
/** The phase curtains: how long one stays up. Timed steps start their clock after it. */
export const PHASE_CURTAIN_MS = 2600;
/** Both sides' five categories revealed: the curtain, the tiles landing, then a 5-second countdown to kick-off. */
export const CATEGORY_REVEAL_MS = PHASE_CURTAIN_MS + 3200 + 5000;
/** The attacker picks this attack's category. */
export const CATEGORY_PICK_MS = 8000;
/** Categories dealt to each side. */
export const CATEGORY_COUNT = 5;
export const NUMERIC_MS = 15_000;
export const BOTH_IN_HOLD_MS = 600;
/** The sky shot: kick, the climb (up to 2.3 s), the distances, the winner and the verdict. */
export const NUMERIC_REVEAL_MS = 6000;
/** The coin toss: up to 4 s to call it, the flip, the result, then a 3-second countdown to kick-off. */
export const LINEUP_MS = 11_000;
export const CARD_PICK_MS = 8000;
export const CARD_REVEAL_MS = 3500;
export const HOME_PICK_MS = 6000;
export const MCQ_MS = 12_000;
/** Penalty shootout: the countdown, the points' bar battle, the kick (the 3D shot plays it), the final result. */
export const SHOOTOUT_INTRO_MS = 3600;
/** Sudden death can't run forever: at this many kicks the better shooter (or the coin) takes it. */
export const SHOOTOUT_MAX_KICKS = 20;
export const SHOOTOUT_BATTLE_MS = 4200;
export const SHOOTOUT_KICK_MS = 3600;
export const SHOOTOUT_DONE_MS = 3200;
export const MCQ_REVEAL_MS = 2000;
/** Long enough to read the result card (playtest: shorter results were easy to miss). */
export const OUTCOME_MS = 3200;
/** Added to every result: the ✓ / ✗ marks and the reason arrow along the pitch (why the ball moved). */
export const REASON_MS = 1000;
/** Shot flight (1 s) + goal celebration (~2 s) before play resumes. */
export const GOAL_OUTCOME_MS = 3400;
/** A steal-and-score: the tackle, then the shot and the celebration. */
export const STOLEN_GOAL_OUTCOME_MS = 5000;
/**
 * The step overlay fading in over the 3D view after a result (or the kick-off board): the next duel's first clock
 * starts once it is in, so no pick or answer time is spent behind the fade.
 */
export const OVERLAY_IN_MS = 300;
export const NAMES: Record<DuelSide, string> = { player: 'You', opponent: 'rustaveli99' };

// ── State ────────────────────────────────────────────────────────────────────

export interface Category {
  id: string;
  name: string;
  imageUrl: string | null;
  icon: string | null;
}


export interface NumericDuel {
  key: number;
  question: NumericItem;
  guesses: Record<DuelSide, DuelGuess>;
  startedAt: number;
  deadline: number;
  result: {
    answer: number;
    guesses: Record<DuelSide, number | null>;
    diffs: Record<DuelSide, number | null>;
    winner: DuelSide;
    reason: DuelReason;
  } | null;
}

export interface Mcq {
  key: number;
  question: GameQuestion;
  categoryName: string;
  /** The category had no unused question left, so a general one stands in. */
  offCategory: boolean;
  answers: Record<DuelSide, number | null>;
  /** When each side's answer went in (for who was faster). */
  answeredAt: Record<DuelSide, number | null>;
  /** Wrong answers already used up by Second Ball. */
  firstMiss: Record<DuelSide, number | null>;
  startedAt: number;
  deadline: number;
  /** Options hidden by each side's 50/50. */
  hidden: Record<DuelSide, number[]>;
  /** Time Wasting: ms taken off each side's answering time. */
  squeeze?: Record<DuelSide, number>;
  /** When each side's 50/50 was played (the screen cuts the two answers out over a beat). */
  hiddenAt: Record<DuelSide, number | null>;
}

/**
 * A card doing something: what the screen shows as the card "firing". `effect` is worded from the owner's side;
 * `{them}` and `{their}` stand for the other side (they/their, or you/your when the opponent owns the card).
 */
export interface CardEvent {
  id: number;
  duelNo: number;
  side: DuelSide;
  card: CardId;
  effect: string;
  /** reveal: as the question opens · question: during it · result: when the duel is settled. */
  phase: 'reveal' | 'question' | 'result';
  /** The other side's card this one cancelled, stopped or beat. */
  against?: { side: DuelSide; card: CardId };
}

/** The outcome note of a shot stopped by Goalkeeper Gloves before any question. */
export const GLOVES_SAVE_NOTE = 'Goalkeeper Gloves save!';

export type Stage = 'idle' | 'showdown' | 'deckReveal' | 'categories' | 'lineup' | 'play' | 'shootout' | 'fulltime';
/** The penalty shootout's steps: the countdown, the question, the bar battle of the points, the kick, the result. */
export type ShootoutStep = 'intro' | 'mcq' | 'battle' | 'kick' | 'done';
export interface ShootoutState {
  /** Who shot first (the side that kicked off the match). */
  opener: DuelSide;
  kicks: Kick[];
  step: ShootoutStep;
  winner: DuelSide | null;
  /** The goal every penalty is taken at, picked at random: the one the player attacks ('right') or defends ('left'). */
  goal: 'left' | 'right';
}
/** `category`: the attacker picks this attack's category (the first step of every round). */
export type BattleStep = 'category' | 'cards' | 'reveal' | 'mcq' | 'mcqReveal' | 'numeric' | 'numericReveal' | 'outcome';
/** When cards can be played: only before a round's first duel, or before every duel. */
export type CardWindowMode = 'round' | 'question';

type PerSide<T> = Record<DuelSide, T>;
const both = <T,>(value: T): PerSide<T> => ({ player: value, opponent: value });

export interface MatchState {
  stage: Stage;
  /** Bumped on every scheduled transition so the clock re-arms. */
  seq: number;
  advanceAt: number | null;
  score: PerSide<number>;
  /** Who kicked off the match (the coin toss). */
  kickoff: DuelSide;
  categoryPool: Category[];
  /** Each side's five categories, dealt at random before kick-off. */
  categories: PerSide<Category[]>;
  /** Ids of the categories each side has already attacked with. */
  usedCategories: PerSide<string[]>;
  /** The category of the attack in progress (every question of the round comes from it). */
  roundCategory: Category | null;
  numeric: NumericDuel | null;
  /** 0-based round (possession) number; the match has MATCH_ROUNDS. */
  round: number;
  possession: Possession;
  battleStep: BattleStep;
  mcq: Mcq | null;
  outcome: BattleOutcome | null;
  outcomeNote: string | null;
  /** Where the ball was before the last duel — the pitch replays a goal from there. */
  outcomeFrom: Possession | null;
  /** The previous duel's result, kept on screen through the next duel. */
  lastOutcome: BattleOutcome | null;
  lastOutcomeNote: string | null;
  /** Every answered duel per side, for the full-time stats (null = no answer). */
  answerLog: PerSide<Array<'correct' | 'wrong' | null>>;
  usedQuestionIds: string[];
  usedNumericIds: string[];
  feed: string[];
  // cards
  windowMode: CardWindowMode;
  /** Each side's playstyles (up to 3, within the loadout budget), chosen before the search and revealed at the showdown. */
  deck: PerSide<CardId[]>;
  used: PerSide<CardId[]>;
  /** Global duel counter (1-based once play starts). */
  duelNo: number;
  duelInRound: number;
  /** This duel has a card window (blind pick, reveal, live cards, reactions). */
  cardWindow: boolean;
  /** Blind pick: undefined while still deciding, null for no card. */
  choice: PerSide<CardId | null | undefined>;
  /** Every card played this duel (blind, reaction, live). */
  played: PerSide<CardId[]>;
  /** The side's blind card was cancelled by VAR or Shin Pads. */
  cancelled: PerSide<boolean>;
  /** What a Dummy Run showed the other side. */
  dummyShownAs: PerSide<CardId | null>;
  gloves: PerSide<boolean>;
  tiki: PerSide<number>;
  /** Rule variant (RULES.energy): each side's energy to pay for playstyles during the match. */
  energy: PerSide<number>;
  /** The side can't play cards up to and including this duel number. */
  yellowThrough: PerSide<number>;
  homeCategoryId: string | null;
  /** A drawn match's penalty shootout (null until there is one). */
  shootout: ShootoutState | null;
  /** The latest cards to fire, oldest first (a short rolling window). */
  cardEvents: CardEvent[];
}

/** A number question for the tiebreak (the answer is `value`; it reaches a player only at the reveal). */
export interface NumericItem {
  id: string;
  /** Text per language. */
  prompt: Record<string, string>;
  unit: Record<string, string>;
  value: number;
  /** Granularity of the answer, used to round scripted guesses. */
  step: number;
  /** Decimals a guess may carry. */
  precision: number;
}

export interface Content {
  mcqByCategory: Record<string, GameQuestion[]>;
  fallbackMcqs: GameQuestion[];
  /** The number questions for the tiebreak (the match takes unused ones first). */
  numerics: NumericItem[];
}

export type Action =
  | { type: 'RESTART'; categoryPool: Category[]; decks: PerSide<CardId[]>; windowMode: CardWindowMode; now: number }
  /** Abandon the match: no timers stay armed and the scripted opponent goes quiet. */
  | { type: 'RESET' }
  | { type: 'SET_WINDOW_MODE'; windowMode: CardWindowMode }
  | { type: 'ADVANCE'; content: Content; now: number }
  | { type: 'GUESS'; side: DuelSide; value: number; now: number }
  /** `questionId`: the question the answer was given to — a stale tap on a substituted question is dropped. */
  | { type: 'ANSWER'; side: DuelSide; index: number; questionId?: string; now: number }
  /** The attacker picks this attack's category from their unused ones. */
  | { type: 'PICK_CATEGORY'; side: DuelSide; categoryId: string; content: Content; now: number }
  | { type: 'CHOOSE_CARD'; side: DuelSide; card: CardId | null; now: number }
  /** VAR Review or Shin Pads, against the card the other side just revealed. */
  | { type: 'PLAY_REACTION'; side: DuelSide; card: CardId; now: number }
  | { type: 'PLAY_LIVE'; side: DuelSide; card: CardId; content: Content; now: number }
  /** Home Advantage: its owner picks the duel's category during the reveal. */
  | { type: 'CHOOSE_HOME_CATEGORY'; categoryId: string; side?: DuelSide }
  /** Dev Card Lab: one staged duel from `possession`, with these decks. */
  | { type: 'LAB_DUEL'; categoryPool: Category[]; decks: PerSide<CardId[]>; possession: Possession; content: Content; now: number }
  /** Dev shootout lab: straight to penalties at a level score. */
  | { type: 'LAB_SHOOTOUT'; categoryPool: Category[]; opener: DuelSide; now: number };

export const IDLE: MatchState = {
  stage: 'idle',
  seq: 0,
  advanceAt: null,
  score: both(0),
  kickoff: 'player',
  categoryPool: [],
  categories: both([]),
  usedCategories: both([]),
  roundCategory: null,
  numeric: null,
  round: 0,
  possession: { attacker: 'player', zone: 'centre' },
  battleStep: 'mcq',
  mcq: null,
  outcome: null,
  outcomeNote: null,
  outcomeFrom: null,
  lastOutcome: null,
  lastOutcomeNote: null,
  answerLog: both([]),
  usedQuestionIds: [],
  usedNumericIds: [],
  feed: [],
  windowMode: 'round',
  deck: both([]),
  used: both([]),
  duelNo: 0,
  duelInRound: 0,
  cardWindow: false,
  choice: both(undefined),
  played: both([]),
  cancelled: both(false),
  dummyShownAs: both(null),
  gloves: both(false),
  tiki: both(0),
  energy: both(0),
  yellowThrough: both(0),
  homeCategoryId: null,
  shootout: null,
  cardEvents: [],
};

const coinFlip = (): DuelSide => (rand() < 0.5 ? 'player' : 'opponent');
const plural = (side: DuelSide, verb: string) => (side === 'player' ? verb : `${verb}s`);

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const schedule = (s: MatchState, patch: Partial<MatchState>, advanceAt: number | null): MatchState => ({
  ...s,
  ...patch,
  advanceAt,
  seq: s.seq + 1,
});

const log = (s: MatchState, ...lines: string[]) => [...lines.reverse(), ...s.feed].slice(0, 14);

function fire(
  events: CardEvent[],
  duelNo: number,
  side: DuelSide,
  card: CardId,
  effect: string,
  phase: CardEvent['phase'],
  against?: CardId,
): CardEvent[] {
  const id = (events[events.length - 1]?.id ?? 0) + 1;
  const event: CardEvent = { id, duelNo, side, card, effect, phase, ...(against ? { against: { side: otherZoneSide(side), card: against } } : {}) };
  return [...events, event].slice(-16);
}

// ── Cards ────────────────────────────────────────────────────────────────────

/** Cards that take effect this duel: blind cards cancelled by VAR or Shin Pads, and Dummy Runs, have none. */
export function activeCards(s: MatchState): ActiveCards {
  const live = (side: DuelSide) =>
    s.played[side].filter((id, i) => !(i === 0 && s.cancelled[side] && CARD_BY_ID[id].phase === 'blind') && !BLUFF_CARDS.includes(id));
  return { player: live('player'), opponent: live('opponent') };
}

/** The blind card `side` shows the other side at the reveal: a Dummy Run shows as its fake sabotage. */
export function revealedCard(s: MatchState, side: DuelSide): CardId | null {
  const card = s.choice[side] ?? null;
  return card && BLUFF_CARDS.includes(card) ? s.dummyShownAs[side] : card;
}

/** Why `side` can't answer the other side's revealed card with `card` (VAR Review or Shin Pads), or null when it can. */
export function reactionBlocker(s: MatchState, side: DuelSide, card: CardId): string | null {
  const target = otherZoneSide(side);
  if (s.stage !== 'play' || s.battleStep !== 'reveal') return 'Only right after the reveal';
  const seen = revealedCard(s, target);
  if (!seen || s.cancelled[target]) return 'No card to answer';
  if (card === 'shin-pads' && CARD_BY_ID[seen].type !== 'sabotage') return 'Shin Pads only stop sabotage';
  return cardBlocker(s, side, card, 'reaction');
}

/** The attacker's cards that get past Goalkeeper Gloves. */
const beatsGloves = (cards: CardId[]) =>
  cards.includes('golden-boot') || cards.includes('nutmeg') || cards.includes('bicycle-kick');

/** Each side attacks MATCH_ROUNDS / 2 times. */
export const ATTACKS_EACH = MATCH_ROUNDS / 2;

/**
 * Attacks the side still has, counting the one in progress until its round is over. Turns always alternate, so the
 * rounds ahead go to the sides in turn from the round on screen (its attacker during a result is the one that just
 * attacked: `outcomeFrom`).
 */
export function attacksLeft(s: MatchState, side: DuelSide): number {
  if (s.stage === 'fulltime') return 0;
  if (s.stage !== 'play') return ATTACKS_EACH;
  const result = s.battleStep === 'outcome';
  const current = result && s.outcomeFrom ? s.outcomeFrom.attacker : s.possession.attacker;
  const from = s.round + (result && s.outcome?.roundOver ? 1 : 0);
  let left = 0;
  for (let round = from; round < MATCH_ROUNDS; round += 1) {
    if (((round - s.round) % 2 === 0 ? current : otherZoneSide(current)) === side) left += 1;
  }
  return left;
}

/** The side's attack in round `round` (0-based) is its nth (1-based). */
export function attackNumber(round: number): number {
  return Math.floor(round / 2) + 1;
}

/**
 * What the player may see of the opponent's used playstyles. While an opponent's Dummy Run is still up for VAR, it
 * shows as the sabotage card it pretends to be — that card spent — so the bluff holds.
 */
export function opponentPublicView(s: MatchState): { used: CardId[] } {
  const fake = s.dummyShownAs.opponent;
  const bluffing = s.battleStep === 'reveal' && !!s.choice.opponent && BLUFF_CARDS.includes(s.choice.opponent) && !s.cancelled.opponent && fake !== null;
  if (!bluffing) return { used: s.used.opponent };
  return { used: [...s.used.opponent.filter((id) => !BLUFF_CARDS.includes(id)), fake] };
}

export interface DuelStakes {
  /** 'answers' while the question is open; 'numeric' once both were right and the number question decides. */
  mode: 'answers' | 'numeric';
  /** You right and they wrong — or, in a tiebreak, your guess closer. */
  win: BattleOutcome;
  /** You wrong and they right — or, in a tiebreak, their guess closer. */
  lose: BattleOutcome;
  /** Both wrong; null in a tiebreak (both were right). */
  bothWrong: BattleOutcome | null;
  /** The defender's Goalkeeper Gloves will stop this shot before it is asked. */
  glovesWillSave: boolean;
}

/**
 * What this duel decides, seen from the player. Each answer scenario runs through the same card-aware settlement as
 * the real result (decideDuel, then movementMods), so the preview never disagrees with what happens.
 */
export function duelStakes(s: MatchState): DuelStakes {
  const active = activeCards(s);
  const attacker = s.possession.attacker;
  const defender = otherZoneSide(attacker);
  // Gloves and Tiki-Taka switch on as the question opens; while they are only revealed, count them already.
  const tiki = {
    player: s.tiki.player > 0 || active.player.includes('tiki-taka'),
    opponent: s.tiki.opponent > 0 || active.opponent.includes('tiki-taka'),
  };
  const gloves = (side: DuelSide) => s.gloves[side] || active[side].includes('goalkeeper-gloves');
  const settle = (correct: Record<DuelSide, boolean>, tiebreakWinner: DuelSide) => {
    const decision = decideDuel(s.possession, correct, active);
    const winner = decision.kind === 'numeric' ? tiebreakWinner : decision.winner;
    return resolveBattle(s.possession, winner, movementMods(s.possession, winner, active, tiki, correct));
  };
  const glovesWillSave = s.possession.zone === 'opponent' && gloves(defender) && !beatsGloves(active[attacker]);
  if (s.battleStep === 'numeric' || s.battleStep === 'numericReveal') {
    const bothRight = { player: true, opponent: true };
    return { mode: 'numeric', win: settle(bothRight, 'player'), lose: settle(bothRight, 'opponent'), bothWrong: null, glovesWillSave };
  }
  return {
    mode: 'answers',
    win: settle({ player: true, opponent: false }, 'player'),
    lose: settle({ player: false, opponent: true }, 'opponent'),
    bothWrong: settle({ player: false, opponent: false }, 'player'),
    glovesWillSave,
  };
}

/** Sabotage cards hitting `side` this duel. */
export function sabotageOn(s: MatchState, side: DuelSide): CardId[] {
  return activeCards(s)[otherZoneSide(side)].filter((id) => CARD_BY_ID[id].type === 'sabotage');
}

/** Why `side` can't play `card` right now, or null when it can. */
export function cardBlocker(s: MatchState, side: DuelSide, card: CardId, phase: CardPhase): string | null {
  const def = CARD_BY_ID[card];
  if (!s.deck[side].includes(card)) return 'Not in your deck';
  if (RULES.energy ? s.energy[side] < def.energy : s.used[side].includes(card)) return RULES.energy ? 'Not enough energy' : 'Used this match';
  if (def.phase !== phase) {
    return def.phase === 'live' ? 'Live card — play it during the question' : def.phase === 'reaction' ? 'Reaction — after their card is revealed' : 'Blind card — before the question';
  }
  if (!s.cardWindow) return 'Cards only before a round';
  if (s.duelNo <= s.yellowThrough[side]) return 'Yellow card — no cards';
  if (s.played[side].length > 0) return 'One card per question';
  if (!roleAllows(def, side, s.possession)) {
    return def.role === 'attack' ? 'Attack card — only on your ball' : def.role === 'defend' ? 'Defend card — only on their ball' : 'Only on your shot';
  }
  if (card === 'home-advantage' && unusedCategories(s, side).length === 0) return 'No categories left to pick';
  if (card === 'screamer' && s.possession.zone !== 'centre') return 'Only from the centre';
  if (card === 'bicycle-kick' && RULES.bicycle === 'comeback') {
    const diff = s.score[side] - s.score[otherZoneSide(side)];
    if (diff > 0) return "Only when you're level or behind";
  }
  if (card === 'super-sub' && !s.used[side].some((id) => id !== 'super-sub')) return 'Nothing used yet to bring back';
  return null;
}

function spend(s: MatchState, side: DuelSide, card: CardId): Pick<MatchState, 'used' | 'played' | 'energy'> {
  return {
    energy: RULES.energy ? { ...s.energy, [side]: s.energy[side] - CARD_BY_ID[card].energy } : s.energy,
    used: { ...s.used, [side]: [...s.used[side], card] },
    played: { ...s.played, [side]: [...s.played[side], card] },
  };
}

// ── Categories ───────────────────────────────────────────────────────────────

/** Deals each side CATEGORY_COUNT random categories — all ten different when the pool allows. */
export function dealCategories(pool: readonly Category[], random: () => number = rand): PerSide<Category[]> {
  const deck = [...pool];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const player = deck.slice(0, CATEGORY_COUNT);
  const rest = deck.slice(CATEGORY_COUNT);
  // A small pool: the opponent's five may repeat some of the player's (never within one side).
  const opponent = [...rest, ...player].slice(0, CATEGORY_COUNT);
  return { player, opponent };
}

/** The side's categories it hasn't attacked with yet. */
export function unusedCategories(s: MatchState, side: DuelSide): Category[] {
  return s.categories[side].filter((category) => !s.usedCategories[side].includes(category.id));
}

/** Starts round `round`: the attacker's category pick. */
function startRound(s: MatchState, now: number, round: number, possession: Possession, lines: string[] = []): MatchState {
  return schedule(
    s,
    {
      stage: 'play',
      battleStep: 'category',
      round,
      duelInRound: 0,
      possession,
      roundCategory: null,
      mcq: null,
      numeric: null,
      outcome: null,
      outcomeNote: null,
      feed: log(s, ...lines, `Round ${round + 1}/${MATCH_ROUNDS}: ${NAMES[possession.attacker]} ${plural(possession.attacker, 'attack')}`),
    },
    now + CATEGORY_PICK_MS,
  );
}

/** The attacker's pick (or the timeout's random one): the round's category, used up; then the round's first duel. */
function applyCategoryPick(s: MatchState, side: DuelSide, categoryId: string | null, content: Content, now: number): MatchState {
  if (s.stage !== 'play' || s.battleStep !== 'category' || s.possession.attacker !== side) return s;
  const open = unusedCategories(s, side);
  // Out of categories (only in staged duels): any of the side's own.
  const pool = open.length > 0 ? open : s.categories[side];
  const category = categoryId ? pool.find((c) => c.id === categoryId) : pool[Math.floor(rand() * pool.length)];
  if (!category && pool.length > 0) return s;
  const picked: MatchState = {
    ...s,
    roundCategory: category ?? null,
    usedCategories: category ? { ...s.usedCategories, [side]: [...s.usedCategories[side], category.id] } : s.usedCategories,
    feed: category ? log(s, `${NAMES[side]} ${plural(side, 'attack')} with ${category.name}`) : s.feed,
  };
  return startDuel(picked, content, now, { duelInRound: 0 });
}

function newNumeric(s: MatchState, content: Content, now: number): Pick<MatchState, 'numeric' | 'usedNumericIds'> {
  const unused = content.numerics.filter((question) => !s.usedNumericIds.includes(question.id));
  const pool = unused.length > 0 ? unused : content.numerics;
  const question = pool[Math.floor(rand() * pool.length)];
  return {
    numeric: {
      key: s.seq + 1,
      question,
      guesses: both<DuelGuess>({ value: null, lockedAtMs: null }),
      startedAt: now,
      deadline: now + NUMERIC_MS,
      result: null,
    },
    usedNumericIds: unused.length > 0 ? [...s.usedNumericIds, question.id] : [question.id],
  };
}

function resolveNumeric(duel: NumericDuel): NumericDuel {
  const outcome = decideNumericDuel(duel.question.value, duel.question.precision, duel.guesses, coinFlip);
  return {
    ...duel,
    result: {
      answer: duel.question.value,
      guesses: { player: duel.guesses.player.value, opponent: duel.guesses.opponent.value },
      diffs: outcome.diffs,
      winner: outcome.winner,
      reason: outcome.reason,
    },
  };
}

// ── Duels ────────────────────────────────────────────────────────────────────

function newMcq(s: MatchState, content: Content, now: number): Pick<MatchState, 'mcq' | 'usedQuestionIds'> {
  const home = s.homeCategoryId ? [...s.categories.player, ...s.categories.opponent].find((c) => c.id === s.homeCategoryId) : undefined;
  const category = home ?? s.roundCategory ?? undefined;
  const fresh = (questions: GameQuestion[]) => questions.filter((question) => !s.usedQuestionIds.includes(question.id));
  const fromCategory = fresh(category ? content.mcqByCategory[category.id] ?? [] : []);
  const fallback = fresh(content.fallbackMcqs);
  // Every unused question anywhere goes before a repeat: a question already revealed is an answer oracle. The last
  // resort is every question the pack holds (the pack schema guarantees 20+), never a possibly-empty fallback list.
  const anyFresh = fromCategory.length > 0 || fallback.length > 0 ? [] : fresh(Object.values(content.mcqByCategory).flat());
  const anyAtAll = Object.values(content.mcqByCategory).flat();
  const source = fromCategory.length > 0 ? fromCategory : fallback.length > 0 ? fallback : anyFresh.length > 0 ? anyFresh : anyAtAll.length > 0 ? anyAtAll : content.fallbackMcqs;
  const question = source[Math.floor(rand() * source.length)];
  return {
    mcq: {
      key: s.seq + 1,
      question,
      categoryName: category?.name ?? '',
      offCategory: fromCategory.length === 0,
      answers: both(null),
      answeredAt: both(null),
      firstMiss: both(null),
      startedAt: now,
      deadline: now + MCQ_MS,
      hidden: both([]),
      hiddenAt: both(null),
    },
    usedQuestionIds: [...s.usedQuestionIds, question.id],
  };
}

// ── Penalty shootout ─────────────────────────────────────────────────────────

/** The next kick's question: from a random category of either side's, both answer it. */
function shootoutQuestion(s: MatchState, content: Content, now: number): MatchState {
  const pool = [...s.categories.player, ...s.categories.opponent];
  const roundCategory = pool.length > 0 ? pool[Math.floor(rand() * pool.length)] : null;
  const withCategory = { ...s, roundCategory, homeCategoryId: null };
  const shooter = nextShooter(s.shootout!.kicks, s.shootout!.opener);
  const mcq = newMcq(withCategory, content, now);
  return schedule(
    withCategory,
    {
      ...mcq,
      battleStep: 'mcq',
      // A new duel for the scene, so every kick's shot replays.
      duelNo: s.duelNo + 1,
      possession: { attacker: shooter, zone: 'opponent' },
      played: both([]),
      choice: both(null),
      cancelled: both(false),
      shootout: { ...s.shootout!, step: 'mcq' },
    },
    mcq.mcq!.deadline,
  );
}

function advanceShootout(s: MatchState, content: Content, now: number): MatchState {
  const so = s.shootout;
  if (!so) return s;
  switch (so.step) {
    case 'intro':
      return shootoutQuestion(s, content, now);
    case 'mcq': {
      // The answers become points (Ranked 1.0's), and the bar battle plays them out.
      return schedule(s, { battleStep: 'mcqReveal', shootout: { ...so, step: 'battle' } }, now + SHOOTOUT_BATTLE_MS);
    }
    case 'battle': {
      const mcq = s.mcq!;
      const shooter = s.possession.attacker;
      const pointsOf = (side: DuelSide) => answerPoints(mcq.answers[side] === mcq.question.correctIndex, mcq.answeredAt[side] === null ? null : mcq.answeredAt[side]! - mcq.startedAt, MCQ_MS);
      const kick = resolveKick(shooter, { player: pointsOf('player'), opponent: pointsOf('opponent') });
      const kicks = [...so.kicks, kick];
      const keeper = otherZoneSide(shooter);
      const outcome: BattleOutcome =
        kick.result === 'goal'
          ? { kind: 'goal', scorer: shooter, next: { attacker: keeper, zone: 'opponent' }, roundOver: true }
          : kick.result === 'saved'
            ? { kind: 'turnover', next: { attacker: keeper, zone: 'opponent' }, roundOver: true }
            : { kind: 'bothWrong', next: { attacker: keeper, zone: 'opponent' }, roundOver: true };
      const line = `${NAMES[shooter]}: ${kick.result === 'goal' ? 'scores the penalty' : kick.result === 'saved' ? 'penalty saved' : 'penalty missed'}`;
      return schedule(
        s,
        { battleStep: 'outcome', outcome, outcomeFrom: s.possession, shootout: { ...so, kicks, step: 'kick', winner: shootoutWinner(kicks, so.opener) }, feed: log(s, line) },
        now + SHOOTOUT_KICK_MS,
      );
    }
    case 'kick': {
      if (so.winner) return schedule(s, { shootout: { ...so, step: 'done' }, feed: log(s, `${NAMES[so.winner]} ${plural(so.winner, 'win')} on penalties`) }, now + SHOOTOUT_DONE_MS);
      // Sudden death is bounded: at the cap the side with more penalties in takes it (level: the coin).
      if (so.kicks.length >= SHOOTOUT_MAX_KICKS) {
        const goals = shootoutGoals(so.kicks);
        const winner: DuelSide = goals.player !== goals.opponent ? (goals.player > goals.opponent ? 'player' : 'opponent') : coinFlip();
        return schedule(
          s,
          { shootout: { ...so, winner, step: 'done' }, feed: log(s, `Sudden death all through — ${NAMES[winner]} ${plural(winner, 'take')} it`) },
          now + SHOOTOUT_DONE_MS,
        );
      }
      return shootoutQuestion(s, content, now);
    }
    case 'done':
      return schedule(s, { stage: 'fulltime', mcq: null }, null);
  }
}

/** Starts the next duel: a card window when the mode allows one, otherwise straight to the question. */
function startDuel(s: MatchState, content: Content, now: number, patch: Partial<MatchState> = {}): MatchState {
  const base: MatchState = {
    ...s,
    ...patch,
    stage: 'play',
    duelNo: s.duelNo + 1,
    choice: both(undefined),
    played: both([]),
    cancelled: both(false),
    dummyShownAs: both(null),
    homeCategoryId: null,
    numeric: null,
    mcq: null,
    outcome: null,
    outcomeNote: null,
  };
  const cardWindow = base.windowMode === 'question' || base.duelInRound === 0;
  const next = { ...base, cardWindow };
  if (!cardWindow) return afterCards(next, content, now);
  // Sides with no blind card to play skip the pick.
  const choice = { ...next.choice };
  for (const side of ['player', 'opponent'] as const) {
    const anyBlind = next.deck[side].some((card) => cardBlocker(next, side, card, 'blind') === null);
    if (!anyBlind) choice[side] = null;
  }
  if (choice.player === null && choice.opponent === null) return afterCards({ ...next, choice }, content, now);
  return schedule(next, { battleStep: 'cards', choice, mcq: null }, now + CARD_PICK_MS);
}

/** Blind cards revealed (and possibly VAR'd): apply their standing effects, then play the question. */
function afterCards(s: MatchState, content: Content, now: number): MatchState {
  const active = activeCards(s);
  const next: MatchState = { ...s, gloves: { ...s.gloves }, tiki: { ...s.tiki }, yellowThrough: { ...s.yellowThrough } };
  const notes: string[] = [];
  for (const side of ['player', 'opponent'] as const) {
    const other = otherZoneSide(side);
    if (active[side].includes('yellow-card')) next.yellowThrough[other] = s.duelNo + 1;
    if (active[side].includes('goalkeeper-gloves')) next.gloves[side] = true;
    if (active[side].includes('tiki-taka')) next.tiki[side] = TIKI_TAKA_DUELS;
    if (active[side].includes('super-sub')) {
      // The last other playstyle used comes back to be played again.
      const back = [...s.used[side]].reverse().find((id) => id !== 'super-sub');
      if (back) {
        const i = s.used[side].lastIndexOf(back);
        next.used = { ...(next.used === s.used ? { ...s.used } : next.used), [side]: s.used[side].filter((_, k) => k !== i) };
        notes.push(`Super Sub: ${CARD_BY_ID[back].name} is back`);
      }
    }
  }
  // A category override only stands while the Home Advantage that chose it is still in play (VAR can cancel it);
  // two at once cancel out and the round keeps its own category.
  const playerHome = active.player.includes('home-advantage');
  const opponentHome = active.opponent.includes('home-advantage');
  const homeOwner: DuelSide | null = playerHome === opponentHome ? null : playerHome ? 'player' : 'opponent';
  if (!homeOwner) next.homeCategoryId = null;
  if (playerHome && opponentHome) {
    notes.push('Both played Home Advantage — they cancel out');
  } else if (homeOwner) {
    // The owner picked one of their remaining categories during the reveal (Home Advantage doesn't use one up);
    // when they didn't in time, one is picked for them.
    const open = unusedCategories(s, homeOwner);
    if (!open.some((c) => c.id === next.homeCategoryId)) {
      const pick = open[Math.floor(rand() * open.length)];
      next.homeCategoryId = pick?.id ?? null;
    }
    const chosen = open.find((c) => c.id === next.homeCategoryId);
    if (chosen) notes.push(`Home Advantage: ${NAMES[homeOwner]} chose ${chosen.name}`);
  }
  for (const side of ['player', 'opponent'] as const) {
    if (s.choice[side] && BLUFF_CARDS.includes(s.choice[side]!) && !s.cancelled[side]) notes.push(`${NAMES[side]}'s card was a ${CARD_BY_ID[s.choice[side]!].name}`);
  }

  let events = s.cardEvents;
  const standing: Partial<Record<CardId, string>> = {
    'goalkeeper-gloves': 'gloves on — the next shot on goal is saved',
    'tiki-taka': '+1 zone on every duel won, for 3 duels',
    'yellow-card': "{them} can't play cards this duel or the next",
    'floodlight-failure': '{their} screen goes dark for 4 seconds',
    fog: '{their} answers are hidden until tapped',
    'muddy-pitch': '{their} answers will reshuffle',
  };
  for (const side of ['player', 'opponent'] as const) {
    for (const card of active[side]) {
      const effect = standing[card];
      if (effect) events = fire(events, s.duelNo, side, card, effect, 'reveal');
    }
    if (s.choice[side] && BLUFF_CARDS.includes(s.choice[side]!) && !s.cancelled[side]) events = fire(events, s.duelNo, side, s.choice[side]!, 'it was a bluff — no effect', 'reveal');
  }
  if (playerHome && opponentHome) {
    events = fire(events, s.duelNo, 'player', 'home-advantage', 'both played Home Advantage — they cancel out', 'reveal', 'home-advantage');
  }
  if (s.possession.zone === 'opponent' && next.gloves[otherZoneSide(s.possession.attacker)] && active[s.possession.attacker].includes('golden-boot')) {
    events = fire(events, s.duelNo, s.possession.attacker, 'golden-boot', "the gloves can't stop this shot", 'reveal', 'goalkeeper-gloves');
  }
  if (next.homeCategoryId) {
    const owner: DuelSide = playerHome ? 'player' : 'opponent';
    const name = s.categories[owner].find((category) => category.id === next.homeCategoryId)?.name ?? '';
    events = fire(events, s.duelNo, owner, 'home-advantage', `category: ${name}`, 'reveal');
  }
  next.cardEvents = events;

  const attacker = s.possession.attacker;
  const defender = otherZoneSide(attacker);
  const shot = s.possession.zone === 'opponent';
  if (shot && next.gloves[defender] && !beatsGloves(active[attacker])) {
    next.gloves[defender] = false;
    return applyBattle({ ...next, feed: log(next, ...notes) }, defender, null, now, GLOVES_SAVE_NOTE);
  }
  const mcq = newMcq(next, content, now);
  return schedule(next, { battleStep: 'mcq', ...mcq, feed: notes.length ? log(next, ...notes) : next.feed }, mcq.mcq!.deadline);
}

/**
 * Settles a duel. `attackerCorrect` is null when no question was played (a Goalkeeper Gloves save), so cards that
 * depend on the attacker's answer (Offside Trap, a lost Long Ball) stay out of it.
 */
function applyBattle(s: MatchState, winner: DuelSide | null, correct: Record<DuelSide, boolean> | null, now: number, note?: string): MatchState {
  const attacker = s.possession.attacker;
  const attackerCorrect = correct ? correct[attacker] : null;
  // Rule variant: a right answer earns energy.
  if (RULES.energy && correct) {
    s = { ...s, energy: { player: Math.min(ENERGY_MAX, s.energy.player + (correct.player ? 1 : 0)), opponent: Math.min(ENERGY_MAX, s.energy.opponent + (correct.opponent ? 1 : 0)) } };
  }
  const active = activeCards(s);
  const mods = movementMods(s.possession, winner, active, { player: s.tiki.player > 0, opponent: s.tiki.opponent > 0 }, correct);
  const outcome = resolveBattle(s.possession, winner, mods);
  // Tiki-Taka runs for its owner's next duels whoever has the ball; losing one ends it.
  const tiki = { ...s.tiki };
  for (const side of ['player', 'opponent'] as const) {
    if (tiki[side] <= 0) continue;
    const lost = winner === otherZoneSide(side) || (winner === null && side === attacker);
    tiki[side] = lost ? 0 : tiki[side] - 1;
  }
  const category = s.mcq?.categoryName ?? s.roundCategory?.name ?? '';
  const nextAttacker = NAMES[outcome.next.attacker];
  const line = {
    advance: `${NAMES[attacker]} ${plural(attacker, 'move')} forward${mods.attackerSteps > 1 ? ` ${mods.attackerSteps} zones` : ''}`,
    held: `${NAMES[attacker]} ${plural(attacker, 'win')} it but the bus is parked — no ground`,
    goal: outcome.kind === 'goal' && outcome.stolen ? `STOLEN AND SCORED — ${NAMES[outcome.scorer]}` : `GOAL — ${NAMES[attacker]}`,
    turnover: `${nextAttacker} ${mods.cleanSteal ? 'stole the ball' : 'won the ball'} → ${plural(outcome.next.attacker, 'attack')} from ${pitchLabel(outcome.next)}`,
    bothWrong: `Both wrong → ${nextAttacker} ${plural(outcome.next.attacker, 'take')} over at ${pitchLabel(outcome.next)}`,
  }[outcome.kind];
  const score = outcome.kind === 'goal' ? { ...s.score, [outcome.scorer]: s.score[outcome.scorer] + 1 } : s.score;
  const cardEvents = settlementEvents(s, winner, attackerCorrect, outcome, active, tiki, note);
  return schedule(
    s,
    {
      cardEvents,
      stage: 'play',
      battleStep: 'outcome',
      outcome,
      outcomeNote: note ?? null,
      outcomeFrom: s.possession,
      lastOutcome: outcome,
      lastOutcomeNote: note ?? null,
      possession: outcome.next,
      score,
      tiki,
      feed: log(s, `R${s.round + 1} ${category}: ${note ? `${note} · ` : ''}${line}`),
    },
    now + REASON_MS + (outcome.kind === 'goal' ? (outcome.stolen ? STOLEN_GOAL_OUTCOME_MS : GOAL_OUTCOME_MS) : OUTCOME_MS),
  );
}

/** The cards that decided or moved this duel, as events for the result screen. */
function settlementEvents(
  s: MatchState,
  winner: DuelSide | null,
  attackerCorrect: boolean | null,
  outcome: BattleOutcome,
  active: ActiveCards,
  tikiAfter: PerSide<number>,
  note: string | undefined,
): CardEvent[] {
  const attacker = s.possession.attacker;
  const defender = otherZoneSide(attacker);
  const has = (side: DuelSide, card: CardId) => active[side].includes(card);
  const goal = outcome.kind === 'goal';
  let events = s.cardEvents;
  const add = (side: DuelSide, card: CardId, effect: string, against?: CardId) => {
    events = fire(events, s.duelNo, side, card, effect, 'result', against);
  };
  if (note === GLOVES_SAVE_NOTE) add(defender, 'goalkeeper-gloves', 'shot saved');
  if (note === 'Golden Boot') {
    if (has(defender, 'park-the-bus')) add(attacker, 'golden-boot', "goal — the bus can't stop it", 'park-the-bus');
    else add(attacker, 'golden-boot', 'goal — no tiebreak needed');
  }
  if (note === 'First Touch' && winner) add(winner, 'first-touch', 'won it — no tiebreak needed');
  if (note === 'Long Ball lands') add(attacker, 'long-ball', goal ? 'straight in — goal' : 'straight to {their} side');
  if (note === 'Long Ball cut out') add(attacker, 'long-ball', 'cut out — {them} break forward');
  if (note === 'Offside trap!') add(defender, 'offside-trap', 'offside! the ball is won high up the pitch');
  if (winner === attacker && outcome.kind !== 'held' && !has(attacker, 'long-ball')) {
    if (has(attacker, 'captains-armband')) add(attacker, 'captains-armband', goal ? '+1 zone — straight to goal' : '+1 zone');
    if (s.tiki[attacker] > 0) add(attacker, 'tiki-taka', `+1 zone${tikiAfter[attacker] > 0 ? ` (${tikiAfter[attacker]} left)` : ''}`);
  }
  // A Gloves save is the defender's win too (no answers): its Counter-Attack / Tiki-Taka zone is moved, so it is named.
  if (winner === defender && winner !== null && (attackerCorrect !== null || note === GLOVES_SAVE_NOTE)) {
    if (has(defender, 'counter-attack')) add(defender, 'counter-attack', 'breaks straight into {their} half');
    if (s.tiki[defender] > 0) add(defender, 'tiki-taka', `+1 zone${tikiAfter[defender] > 0 ? ` (${tikiAfter[defender]} left)` : ''}`);
  }
  if (outcome.kind === 'held') {
    // The bus names the movement card it stopped, if the attacker had one.
    const stopped = (['long-ball', 'captains-armband'] as const).find((card) => has(attacker, card)) ?? (s.tiki[attacker] > 0 ? 'tiki-taka' : undefined);
    if (stopped) add(defender, 'park-the-bus', `stopped {their} ${CARD_BY_ID[stopped].name}`, stopped);
    else add(defender, 'park-the-bus', 'no ground given');
  }
  return events;
}

function advance(s: MatchState, content: Content, now: number): MatchState {
  switch (s.stage) {
    case 'showdown':
      return schedule(s, { stage: 'deckReveal', feed: log(s, 'Decks revealed') }, now + revealSchedule(s.deck).total);
    case 'deckReveal':
      return schedule(s, { stage: 'categories', categories: dealCategories(s.categoryPool), usedCategories: both([]), feed: log(s, 'Categories dealt') }, now + CATEGORY_REVEAL_MS);
    case 'categories':
      return schedule(s, { stage: 'lineup' }, now + LINEUP_MS);
    case 'lineup':
      return startRound(s, now + OVERLAY_IN_MS, 0, { attacker: s.kickoff, zone: 'centre' }, [`${NAMES[s.kickoff]} ${plural(s.kickoff, 'kick')} off`]);
    case 'shootout':
      return advanceShootout(s, content, now);
    case 'play':
      switch (s.battleStep) {
        case 'category':
          return applyCategoryPick(s, s.possession.attacker, null, content, now);
        case 'cards': {
          const choice = { player: s.choice.player ?? null, opponent: s.choice.opponent ?? null };
          let next: MatchState = { ...s, choice };
          const lines: string[] = [];
          for (const side of ['player', 'opponent'] as const) {
            const card = choice[side];
            if (!card) continue;
            next = { ...next, ...spend(next, side, card) };
            if (BLUFF_CARDS.includes(card)) {
              // Decks may be public, so the bluff passes for a card of its kind the bluffer still holds (any if none).
              // It must also fit the moment: no fake Golden Boot from midfield.
              const all = BLUFF_FAKES[card]!;
              const fitting = all.filter((id) => roleAllows(CARD_BY_ID[id], side, next.possession));
              const kinds = fitting.length > 0 ? fitting : all;
              const own = next.deck[side].filter((id) => kinds.includes(id) && !next.used[side].includes(id));
              const fakes = own.length > 0 ? own : kinds;
              const fake = fakes[Math.floor(rand() * fakes.length)];
              next.dummyShownAs = { ...next.dummyShownAs, [side]: fake };
              // The log shows the bluff until the VAR window has passed; the player knows their own.
              lines.push(side === 'player' ? `You played ${CARD_BY_ID[card].name} (shown as ${CARD_BY_ID[fake].name})` : `${NAMES[side]} played ${CARD_BY_ID[fake].name}`);
              continue;
            }
            lines.push(`${NAMES[side]} played ${CARD_BY_ID[card].name}`);
          }
          if (!choice.player && !choice.opponent) return afterCards(next, content, now);
          const homePick = choice.player === 'home-advantage' || choice.opponent === 'home-advantage';
          return schedule(next, { battleStep: 'reveal', feed: log(next, ...lines) }, now + (homePick ? HOME_PICK_MS : CARD_REVEAL_MS));
        }
        case 'reveal':
          return afterCards(s, content, now);
        case 'mcq': {
          // The Second Ball events held back while the question was open (they would have told on the misser).
          let events = s.cardEvents;
          for (const side of ['player', 'opponent'] as const) {
            if (s.mcq?.firstMiss[side] !== null && s.mcq?.firstMiss[side] !== undefined) {
              events = fire(events, s.duelNo, side, 'second-ball', 'wrong — one more try', 'question');
            }
          }
          return schedule(s, { battleStep: 'mcqReveal', cardEvents: events }, now + MCQ_REVEAL_MS);
        }
        case 'mcqReveal': {
          if (!s.mcq) return s;
          const correct = {
            player: s.mcq.answers.player === s.mcq.question.correctIndex,
            opponent: s.mcq.answers.opponent === s.mcq.question.correctIndex,
          };
          // A Second Ball miss whose retry ran out still counts as an answer — a wrong one.
          const mark = (side: DuelSide) =>
            s.mcq!.answers[side] === null ? (s.mcq!.firstMiss[side] !== null ? 'wrong' : null) : correct[side] ? 'correct' : 'wrong';
          const logged: MatchState = {
            ...s,
            answerLog: { player: [...s.answerLog.player, mark('player')], opponent: [...s.answerLog.opponent, mark('opponent')] },
          };
          const at = s.mcq.answeredAt;
          const faster = at.player !== null && at.opponent !== null && at.player !== at.opponent ? (at.player < at.opponent ? 'player' : 'opponent') : null;
          const decision = decideDuel(s.possession, correct, activeCards(s), faster);
          if (decision.kind === 'numeric') {
            // No unused number question left: a repeat would hand its answer to whoever remembers the reveal.
            if (!content.numerics.some((question) => !logged.usedNumericIds.includes(question.id))) {
              return applyBattle(logged, coinFlip(), correct, now, 'Out of number questions — luck decides');
            }
            const numeric = newNumeric(logged, content, now);
            const firstTouches = activeCards(s);
            const cancelOut = firstTouches.player.includes('first-touch') && firstTouches.opponent.includes('first-touch');
            const cardEvents = cancelOut
              ? fire(s.cardEvents, s.duelNo, 'player', 'first-touch', 'both played First Touch — the number question decides', 'question', 'first-touch')
              : s.cardEvents;
            return schedule(logged, { battleStep: 'numeric', ...numeric, cardEvents }, numeric.numeric!.deadline);
          }
          return applyBattle(logged, decision.winner, correct, now, decision.note);
        }
        case 'numeric':
          return s.numeric ? schedule(s, { battleStep: 'numericReveal', numeric: resolveNumeric(s.numeric) }, now + NUMERIC_REVEAL_MS) : s;
        case 'numericReveal':
          // The number question only comes up when both answered right.
          return applyBattle(s, s.numeric?.result?.winner ?? null, { player: true, opponent: true }, now);
        case 'outcome': {
          // The step overlay fades back in for the next step: its clock starts once it is in (OVERLAY_IN_MS).
          if (s.outcome && !s.outcome.roundOver) return startDuel(s, content, now + OVERLAY_IN_MS, { duelInRound: s.duelInRound + 1 });
          // The ball changed hands (or went in): the next round is the other side's attack — after a steal-and-score
          // too, so both sides always get the same number of attacks.
          const round = s.round + 1;
          if (round >= MATCH_ROUNDS) {
            if (s.score.player !== s.score.opponent) return schedule(s, { stage: 'fulltime', mcq: null, numeric: null, round: MATCH_ROUNDS }, null);
            // Level at full time: penalties.
            return schedule(
              s,
              { stage: 'shootout', mcq: null, numeric: null, round: MATCH_ROUNDS, shootout: { opener: s.kickoff, kicks: [], step: 'intro', winner: null, goal: rand() < 0.5 ? 'left' : 'right' }, feed: log(s, 'Level at full time — penalties') },
              now + SHOOTOUT_INTRO_MS,
            );
          }
          return startRound(s, now + OVERLAY_IN_MS, round, s.possession);
        }
      }
      return s;
    default:
      return s;
  }
}

/** A loadout as the match uses it: the legal picks, or a random loadout when none were made. */
function matchDeck(picks: readonly CardId[]): CardId[] {
  const deck = legalDeck(picks);
  return deck.length > 0 ? deck : completeDeck([]);
}

export function reducer(s: MatchState, action: Action): MatchState {
  switch (action.type) {
    case 'RESTART': {
      const first = coinFlip();
      return schedule(
        {
          ...IDLE,
          categoryPool: action.categoryPool,
          kickoff: first,
          // Decks arrive legal from the deck screen (up to 3 within the budget): an illegal pick is dropped, and an
          // empty loadout is filled at random.
          deck: { player: matchDeck(action.decks.player), opponent: matchDeck(action.decks.opponent) },
          windowMode: action.windowMode,
          energy: both(RULES.energy ? ENERGY_START : 0),
        },
        { stage: 'showdown', feed: [`Coin toss: ${NAMES[first]} ${plural(first, 'kick')} off`] },
        action.now + SHOWDOWN_MS,
      );
    }
    case 'LAB_SHOOTOUT':
      return schedule(
        { ...IDLE, categoryPool: action.categoryPool, categories: dealCategories(action.categoryPool), kickoff: action.opener, score: both(2), round: MATCH_ROUNDS },
        { stage: 'shootout', shootout: { opener: action.opener, kicks: [], step: 'intro', winner: null, goal: rand() < 0.5 ? 'left' : 'right' }, feed: ['Level at full time — penalties'] },
        action.now + SHOOTOUT_INTRO_MS,
      );
    case 'RESET':
      return IDLE;
    case 'SET_WINDOW_MODE':
      return { ...s, windowMode: action.windowMode };
    case 'ADVANCE':
      return advance(s, action.content, action.now);
    case 'GUESS': {
      const duel = s.numeric;
      if (!duel || duel.result || duel.guesses[action.side].value !== null) return s;
      const guesses = { ...duel.guesses, [action.side]: { value: action.value, lockedAtMs: action.now } };
      const bothIn = guesses.player.value !== null && guesses.opponent.value !== null;
      return schedule(s, { numeric: { ...duel, guesses } }, bothIn ? action.now + BOTH_IN_HOLD_MS : s.advanceAt);
    }
    case 'ANSWER': {
      const mcq = s.mcq;
      if ((s.stage !== 'play' && s.stage !== 'shootout') || s.battleStep !== 'mcq' || !mcq || mcq.answers[action.side] !== null) return s;
      if (action.questionId !== undefined && action.questionId !== mcq.question.id) return s;
      // Time Wasting: their time ran out early.
      if (action.now > mcq.deadline - (mcq.squeeze?.[action.side] ?? 0)) return s;
      if (mcq.hidden[action.side].includes(action.index) || mcq.firstMiss[action.side] === action.index) return s;
      const wrong = action.index !== mcq.question.correctIndex;
      const secondBall = activeCards(s)[action.side].includes('second-ball') && mcq.firstMiss[action.side] === null;
      if (wrong && secondBall) {
        // No card event yet: the event (even its number in the sequence) would tell the other side the answer was
        // wrong while the question is still open. It fires at the reveal; the misser's own view sees firstMiss now.
        return {
          ...s,
          mcq: { ...mcq, firstMiss: { ...mcq.firstMiss, [action.side]: action.index } },
          feed: log(s, `Second Ball: ${NAMES[action.side]} ${plural(action.side, 'get')} another try`),
        };
      }
      const answers = { ...mcq.answers, [action.side]: action.index };
      const answeredAt = { ...mcq.answeredAt, [action.side]: action.now };
      const bothIn = answers.player !== null && answers.opponent !== null;
      return schedule(s, { mcq: { ...mcq, answers, answeredAt } }, bothIn ? action.now + BOTH_IN_HOLD_MS : s.advanceAt);
    }
    case 'PICK_CATEGORY':
      return applyCategoryPick(s, action.side, action.categoryId, action.content, action.now);
    case 'CHOOSE_CARD': {
      if (s.stage !== 'play' || s.battleStep !== 'cards' || s.choice[action.side] !== undefined) return s;
      if (action.card && cardBlocker(s, action.side, action.card, 'blind') !== null) return s;
      const choice = { ...s.choice, [action.side]: action.card };
      const bothIn = choice.player !== undefined && choice.opponent !== undefined;
      return schedule(s, { choice }, bothIn ? action.now + 300 : s.advanceAt);
    }
    case 'PLAY_REACTION': {
      if (reactionBlocker(s, action.side, action.card) !== null) return s;
      const target = otherZoneSide(action.side);
      const targetCard = s.choice[target]!;
      const wasted = BLUFF_CARDS.includes(targetCard);
      const verb = action.card === 'shin-pads' ? 'block' : 'cancel';
      const prefix = action.card === 'shin-pads' ? 'Shin Pads!' : 'VAR!';
      return {
        ...s,
        ...spend(s, action.side, action.card),
        cardEvents: fire(
          s.cardEvents,
          s.duelNo,
          action.side,
          action.card,
          wasted ? `it was only a ${CARD_BY_ID[targetCard].name}` : `${action.card === 'shin-pads' ? 'blocked' : 'cancelled'} ${CARD_BY_ID[targetCard].name}`,
          'reveal',
          targetCard,
        ),
        cancelled: { ...s.cancelled, [target]: true },
        homeCategoryId: targetCard === 'home-advantage' ? null : s.homeCategoryId,
        feed: log(s, wasted
          ? `${prefix} ${NAMES[action.side]} ${plural(action.side, verb)} it — it was only a Dummy Run`
          : `${prefix} ${NAMES[action.side]} ${plural(action.side, verb)} ${CARD_BY_ID[targetCard].name}`),
      };
    }
    case 'PLAY_LIVE': {
      const mcq = s.mcq;
      if (s.stage !== 'play' || s.battleStep !== 'mcq' || !mcq || mcq.answers[action.side] !== null) return s;
      // The same clock as ANSWER: a card can't buy time a run-out answer no longer has.
      if (action.now > mcq.deadline - (mcq.squeeze?.[action.side] ?? 0)) return s;
      if (cardBlocker(s, action.side, action.card, 'live') !== null) return s;
      const liveEffect: Partial<Record<CardId, string>> = {
        'fifty-fifty': 'two wrong answers gone',
        substitution: 'new question for both',
        'first-touch': 'if both are right, it wins without the tiebreak',
        'time-wasting': '5 seconds less for them',
      };
      const paid = {
        ...s,
        ...spend(s, action.side, action.card),
        cardEvents: fire(s.cardEvents, s.duelNo, action.side, action.card, liveEffect[action.card] ?? 'played', 'question'),
        feed: log(s, `${NAMES[action.side]} played ${CARD_BY_ID[action.card].name}`),
      };
      if (action.card === 'fifty-fifty') {
        const wrong = mcq.question.options.map((_, i) => i).filter((i) => i !== mcq.question.correctIndex && i !== mcq.firstMiss[action.side]);
        const hidden = shuffled(wrong).slice(0, 2);
        return {
          ...paid,
          mcq: { ...mcq, hidden: { ...mcq.hidden, [action.side]: hidden }, hiddenAt: { ...mcq.hiddenAt, [action.side]: action.now } },
        };
      }
      if (action.card === 'time-wasting') {
        const other = otherZoneSide(action.side);
        return { ...paid, mcq: { ...mcq, squeeze: { ...(mcq.squeeze ?? both(0)), [other]: 5000 } } };
      }
      if (action.card === 'substitution') {
        // The new question starts both sides fresh (newMcq resets firstMiss): any Second Ball miss on the old
        // question is void — it is never asked again, so there is nothing to reveal and nothing to leak.
        const swapped = newMcq(paid, action.content, action.now);
        return schedule(paid, { ...swapped, mcq: { ...swapped.mcq!, startedAt: mcq.startedAt } }, swapped.mcq!.deadline);
      }
      return paid;
    }
    case 'LAB_DUEL': {
      // A duel mid-match: categories dealt, the attacker's first one in play.
      const categories = dealCategories(action.categoryPool);
      const roundCategory = categories[action.possession.attacker][0] ?? null;
      const staged: MatchState = {
        ...IDLE,
        categoryPool: action.categoryPool,
        categories,
        usedCategories: { ...both<string[]>([]), [action.possession.attacker]: roundCategory ? [roundCategory.id] : [] },
        roundCategory,
        windowMode: 'question',
        deck: action.decks,
              feed: ['Card Lab'],
      };
      return startDuel(staged, action.content, action.now, { round: 0, duelInRound: 0, possession: action.possession });
    }
    case 'CHOOSE_HOME_CATEGORY': {
      const side = action.side ?? 'player';
      if (s.battleStep !== 'reveal' || s.choice[side] !== 'home-advantage' || s.cancelled[side]) return s;
      if (!unusedCategories(s, side).some((category) => category.id === action.categoryId)) return s;
      return { ...s, homeCategoryId: action.categoryId };
    }
    default:
      // An action this engine doesn't know (e.g. from a page hot-reloaded mid-match) must never drop the state.
      return s;
  }
}
