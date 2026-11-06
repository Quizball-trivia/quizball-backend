// COPY of the web's src/features/zone-match/zoneMatch.cards.ts (one rules implementation; keep byte-identical apart from import paths).
/**
 * Card Clash cards adapted to the zone match (prototype). Source: the owner's Card Clash artifact — names, types,
 * energy costs, timing and roles are kept; effects that relied on mechanics the zone match does not have (answer speed,
 * a separate shot-vs-keeper step, a 5-step pitch) are restated in zone-match terms and carry the artifact's wording in
 * `original`.
 *
 * Zone-match terms used below:
 * - duel: one multiple-choice question (plus the number tiebreak when both answer right);
 * - shot: a duel where the attacker is already in the opponent's side, so winning it scores.
 */

import type { DuelSide } from './numericDuel.js';
import type { AttackZone, Possession } from './zoneMatch.rules.js';
import { MOVEMENT_CARDS, RULES, SABOTAGE_CARDS } from './zoneMatch.playtest.js';
import { rand } from './zoneMatch.random.js';

export type CardType = 'boost' | 'sabotage' | 'defense' | 'tactical';
/** blind: chosen before the question, revealed together · live: during the question · reaction: after the reveal. */
export type CardPhase = 'blind' | 'live' | 'reaction';
export type CardRole = 'any' | 'attack' | 'defend' | 'shot';

export type CardId =
  | 'first-touch' | 'fifty-fifty' | 'golden-boot' | 'captains-armband' | 'second-ball'
  | 'floodlight-failure' | 'muddy-pitch' | 'fog' | 'yellow-card' | 'offside-trap'
  | 'var-review' | 'goalkeeper-gloves' | 'park-the-bus' | 'shin-pads'
  | 'long-ball' | 'counter-attack' | 'substitution' | 'home-advantage' | 'dummy-run' | 'tiki-taka'
  | 'nutmeg' | 'bicycle-kick' | 'high-press' | 'time-wasting' | 'super-sub' | 'feint' | 'poker-face' | 'screamer';

export interface CardDef {
  id: CardId;
  /** English label for the dev match log only; players read zoneMatch.copy (a test keeps the two equal). */
  name: string;
  icon: string;
  type: CardType;
  energy: number;
  phase: CardPhase;
  role: CardRole;
  /** The artifact's text, when the zone-match effect had to differ. */
  original?: string;
  /** The artifact's cost, when playtesting or the balance sims changed it. */
  originalEnergy?: number;
}

/** Playtest: five was too many to keep in mind — a loadout is up to three playstyles, at most one of them sabotage. */
export const DECK_SIZE = 3;
export const MAX_SABOTAGE_IN_DECK = 1;
/**
 * Energy is the loadout's budget, spent when you build it: up to DECK_SIZE playstyles whose costs add up to at most
 * LOADOUT_BUDGET (3 + 2, or 1 + 2 + 2…). In the match there is no energy: each playstyle simply works once.
 */
export const LOADOUT_BUDGET = 5;

/** Floodlight Failure's blackout. The artifact's 1.5 s only mattered when answer speed scored. */
export const FLOODLIGHT_MS = 4000;
export const TIKI_TAKA_DUELS = 3;

// Costs marked originalEnergy were changed after playtesting and bot simulations (thousands of matches, random decks):
// First Touch is played after you see the question, so at 1⚡ it was the best card for strong players; the time-only
// sabotage and Second Ball lose value here because answer speed never decides a duel.
export const CARDS: CardDef[] = [
  {
    id: 'first-touch', name: 'First Touch', icon: '👟', type: 'boost', energy: 2, originalEnergy: 1, phase: 'live', role: 'any',
    original: 'Your answer counts as 1.5 seconds faster.',
  },
  { id: 'fifty-fifty', name: '50/50', icon: '✂️', type: 'boost', energy: 1, phase: 'live', role: 'any' },
  {
    id: 'golden-boot', name: 'Golden Boot', icon: '👢', type: 'boost', energy: 2, phase: 'blind', role: 'shot',
    original: 'Your shot ignores Goalkeeper Gloves. The keeper must answer 1.5 seconds faster than you to save it.',
  },
  {
    id: 'captains-armband', name: "Captain's Armband", icon: '©️', type: 'boost', energy: 2, phase: 'blind', role: 'attack',
  },
  {
    id: 'second-ball', name: 'Second Ball', icon: '🔁', type: 'boost', energy: 1, originalEnergy: 2, phase: 'blind', role: 'any',
    original: 'Answer wrong? You get one more try, with 2 seconds added to your time.',
  },
  {
    id: 'floodlight-failure', name: 'Floodlight Failure', icon: '💡', type: 'sabotage', energy: 2, originalEnergy: 3, phase: 'blind', role: 'any',
    original: "Your opponent's screen goes dark for the first 1.5 seconds.",
  },
  { id: 'muddy-pitch', name: 'Muddy Pitch', icon: '🟫', type: 'sabotage', energy: 2, phase: 'blind', role: 'any' },
  {
    id: 'fog', name: 'Fog', icon: '🌫️', type: 'sabotage', energy: 1, originalEnergy: 2, phase: 'blind', role: 'any',
  },
  {
    id: 'yellow-card', name: 'Yellow Card', icon: '🟨', type: 'sabotage', energy: 2, phase: 'blind', role: 'any',
  },
  {
    id: 'offside-trap', name: 'Offside Trap', icon: '🚩', type: 'sabotage', energy: 2, phase: 'blind', role: 'defend',
    original: 'If the attacker answers faster than you but gets it wrong, you win the ball and move 2 zones.',
  },
  { id: 'var-review', name: 'VAR Review', icon: '📺', type: 'defense', energy: 2, phase: 'reaction', role: 'any' },
  {
    id: 'goalkeeper-gloves', name: 'Goalkeeper Gloves', icon: '🧤', type: 'defense', energy: 3, phase: 'blind', role: 'defend',
    original: 'Automatically save the next shot against you. Stays on until a shot comes.',
  },
  {
    id: 'park-the-bus', name: 'Park the Bus', icon: '🚌', type: 'defense', energy: 2, phase: 'blind', role: 'defend',
  },
  {
    // Blind, it was a guess at when the other side would sabotage and rarely paid off; as a reaction it answers the
    // sabotage you can see — a cheaper, narrower VAR (and Dummy Run can bait it too).
    id: 'shin-pads', name: 'Shin Pads', icon: '🛡️', type: 'defense', energy: 1, phase: 'reaction', role: 'any',
    original: "Sabotage cards can't touch you this question.",
  },
  {
    id: 'long-ball', name: 'Long Ball', icon: '🎯', type: 'tactical', energy: 3, phase: 'blind', role: 'attack',
    original: 'Answer right: straight to a shot on goal. Answer wrong: your opponent gets the shot.',
  },
  {
    // Playtest: at 1⚡ it was the cheapest way to win the ball straight into the opponent's half — priced with the
    // other movement cards (Captain's Armband, Offside Trap) instead.
    id: 'counter-attack', name: 'Counter-Attack', icon: '↩️', type: 'tactical', energy: 2, originalEnergy: 1, phase: 'blind', role: 'defend',
    original: 'Win the ball back in this duel and move 2 zones.',
  },
  { id: 'substitution', name: 'Substitution', icon: '🔄', type: 'tactical', energy: 1, phase: 'live', role: 'any' },
  {
    id: 'home-advantage', name: 'Home Advantage', icon: '🏠', type: 'tactical', energy: 2, phase: 'blind', role: 'any',
    original: 'You choose the topic of this question.',
  },
  {
    id: 'dummy-run', name: 'Dummy Run', icon: '🎭', type: 'tactical', energy: 1, phase: 'blind', role: 'any',
  },
  {
    id: 'tiki-taka', name: 'Tiki-Taka', icon: '🔺', type: 'tactical', energy: 3, phase: 'blind', role: 'attack',
  },
  {
    id: 'nutmeg', name: 'Nutmeg', icon: '🦵', type: 'boost', energy: 2, phase: 'blind', role: 'attack',
  },
  {
    id: 'bicycle-kick', name: 'Bicycle Kick', icon: '🤸', type: 'boost', energy: 3, phase: 'blind', role: 'shot',
  },
  {
    id: 'high-press', name: 'High Press', icon: '🏃', type: 'defense', energy: 2, phase: 'blind', role: 'defend',
  },
  {
    id: 'time-wasting', name: 'Time Wasting', icon: '⏳', type: 'sabotage', energy: 1, phase: 'live', role: 'any',
  },
  {
    id: 'super-sub', name: 'Super Sub', icon: '🔁', type: 'tactical', energy: 2, phase: 'blind', role: 'any',
  },
  {
    id: 'feint', name: 'Feint', icon: '🎭', type: 'tactical', energy: 1, phase: 'blind', role: 'attack',
  },
  {
    id: 'poker-face', name: 'Poker Face', icon: '😐', type: 'tactical', energy: 1, phase: 'blind', role: 'defend',
  },
  {
    id: 'screamer', name: 'Screamer', icon: '🚀', type: 'boost', energy: 3, phase: 'blind', role: 'attack',
  },
];

/** Bluff cards: they show the other side a fake card and have no effect of their own. */
export const BLUFF_CARDS: readonly CardId[] = ['dummy-run', 'feint', 'poker-face'];
/** What each bluff can pass for. */
export const BLUFF_FAKES: Partial<Record<CardId, readonly CardId[]>> = {
  'dummy-run': ['floodlight-failure', 'fog', 'muddy-pitch', 'yellow-card'],
  feint: ['golden-boot', 'captains-armband', 'long-ball'],
  'poker-face': ['goalkeeper-gloves', 'park-the-bus', 'offside-trap'],
};

export const CARD_BY_ID = Object.fromEntries(CARDS.map((card) => [card.id, card])) as Record<CardId, CardDef>;

export type StarterDeckId = 'total-football' | 'park-the-bus' | 'mind-games' | 'counter-press';
export interface StarterDeck {
  id: StarterDeckId;
  cards: CardId[];
}

/** Ready-made loadouts with a clear plan each — all legal (within the budget, at most 1 sabotage). */
export const STARTER_DECKS: StarterDeck[] = [
  { id: 'total-football', cards: ['tiki-taka', 'captains-armband'] },
  { id: 'park-the-bus', cards: ['goalkeeper-gloves', 'park-the-bus'] },
  { id: 'mind-games', cards: ['floodlight-failure', 'dummy-run', 'var-review'] },
  { id: 'counter-press', cards: ['counter-attack', 'golden-boot', 'fifty-fifty'] },
];

/** What a loadout costs in all. */
export function deckCost(deck: readonly CardId[]): number {
  return deck.reduce((sum, id) => sum + CARD_BY_ID[id].energy, 0);
}

export type DeckBlocker = 'deck-full' | 'deck-sabotage' | 'deck-budget';

/** Why a card can't join the deck, or null when it can. */
export function deckBlocker(deck: CardId[], id: CardId): DeckBlocker | null {
  if (deck.includes(id)) return null;
  if (deck.length >= DECK_SIZE) return 'deck-full';
  if (CARD_BY_ID[id].type === 'sabotage' && deck.filter((c) => CARD_BY_ID[c].type === 'sabotage').length >= MAX_SABOTAGE_IN_DECK) {
    return 'deck-sabotage';
  }
  const left = LOADOUT_BUDGET - deckCost(deck);
  if (CARD_BY_ID[id].energy > left) return 'deck-budget';
  return null;
}

/** Nothing else can join: three playstyles, or no other one fits what is left of the budget. */
export function deckFull(deck: CardId[]): boolean {
  return CARDS.every((card) => deck.includes(card.id) || deckBlocker(deck, card.id) !== null);
}

/** The picks that make a legal loadout, in order (unknown, repeated or over-budget ones dropped). */
export function legalDeck(partial: readonly CardId[]): CardId[] {
  const deck: CardId[] = [];
  for (const id of partial) {
    if (id in CARD_BY_ID && !deck.includes(id) && deckBlocker(deck, id) === null) deck.push(id);
  }
  return deck;
}

/** A partial pick topped up at random until nothing else fits — what Auto-pick and the scripted opponent play with. */
export function completeDeck(partial: readonly CardId[], random: () => number = rand): CardId[] {
  const deck = legalDeck(partial);
  // Fisher–Yates: the same draws give the same order on every runtime (a sort with a random comparator does not).
  const pool = [...CARDS];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  for (const card of pool) {
    if (!deck.includes(card.id) && deckBlocker(deck, card.id) === null) deck.push(card.id);
  }
  return deck;
}

export function randomDeck(random: () => number = rand): CardId[] {
  return completeDeck([], random);
}


/** True when the side holds a role that lets it play the card in this possession. */
export function roleAllows(card: CardDef, side: DuelSide, possession: Possession): boolean {
  const attacking = possession.attacker === side;
  switch (card.role) {
    case 'any':
      return true;
    case 'attack':
      return attacking;
    case 'defend':
      return !attacking;
    case 'shot':
      return attacking && possession.zone === 'opponent';
  }
}

/** The cards in play this duel after VAR cancellations (Dummy Run never has an effect). */
export type ActiveCards = Record<DuelSide, CardId[]>;

const has = (active: ActiveCards, side: DuelSide, id: CardId) => active[side].includes(id);

/** Why a duel settled the way it did: a stable id (the screens branch on it and zoneMatch.copy words it). */
export type OutcomeNote =
  | 'gloves-save' | 'out-of-numerics'
  | 'bicycle-miss' | 'bicycle-goal' | 'bicycle-quick' | 'bicycle-read'
  | 'screamer-goal' | 'screamer-wide'
  | 'bus-blocks-run' | 'caught-offside' | 'offside-trap'
  | 'long-ball-lands' | 'long-ball-cut'
  | 'first-touch-misfire' | 'golden-boot' | 'first-touch' | 'high-press' | 'attacker-edge';

export type DuelDecision =
  | { kind: 'numeric' }
  | { kind: 'resolved'; winner: DuelSide | null; note?: OutcomeNote };

/**
 * Who won the duel once both answers are in, with the cards in play. `numeric` = both were right and no card settles
 * it, so the number question decides.
 */
export function decideDuel(
  possession: Possession,
  correct: Record<DuelSide, boolean>,
  active: ActiveCards,
  /** Who got the right answer in first (both right), for Bicycle Kick's 'faster' rule. */
  faster?: DuelSide | null,
): DuelDecision {
  const attacker = possession.attacker;
  const defender: DuelSide = attacker === 'player' ? 'opponent' : 'player';

  // Bicycle Kick (on the shot): a miss is theirs; both right is a goal (comeback) or goes to the faster answer.
  if (has(active, attacker, 'bicycle-kick')) {
    if (!correct[attacker]) return { kind: 'resolved', winner: defender, note: 'bicycle-miss' };
    if (!correct[defender] || RULES.bicycle === 'comeback') return { kind: 'resolved', winner: attacker, note: 'bicycle-goal' };
    if (faster) return { kind: 'resolved', winner: faster, note: faster === attacker ? 'bicycle-quick' : 'bicycle-read' };
  }
  // Screamer (from the centre): all on the attacker's answer.
  if (has(active, attacker, 'screamer')) {
    return correct[attacker] ? { kind: 'resolved', winner: attacker, note: 'screamer-goal' } : { kind: 'resolved', winner: defender, note: 'screamer-wide' };
  }
  const nutmeg = has(active, attacker, 'nutmeg');
  // Rule variant: Park the Bus and Offside Trap read the attacker's run — a movement card is beaten outright (a Nutmeg
  // goes through).
  if (RULES.counters && !nutmeg && MOVEMENT_CARDS.some((id) => has(active, attacker, id))) {
    if (has(active, defender, 'park-the-bus')) return { kind: 'resolved', winner: defender, note: 'bus-blocks-run' };
    if (has(active, defender, 'offside-trap')) return { kind: 'resolved', winner: defender, note: 'caught-offside' };
  }
  if (has(active, attacker, 'long-ball')) {
    return correct[attacker]
      ? { kind: 'resolved', winner: attacker, note: 'long-ball-lands' }
      : { kind: 'resolved', winner: defender, note: 'long-ball-cut' };
  }
  if (!RULES.counters && has(active, defender, 'offside-trap') && !correct[attacker]) {
    return { kind: 'resolved', winner: defender, note: 'offside-trap' };
  }
  if (correct[attacker] && !correct[defender]) return { kind: 'resolved', winner: attacker };
  if (correct[defender] && !correct[attacker]) return { kind: 'resolved', winner: defender };
  if (!correct[attacker] && !correct[defender]) {
    // Rule variant: a First Touch played and got wrong hands the duel over.
    if (RULES.downsides) {
      const aFt = has(active, attacker, 'first-touch');
      const dFt = has(active, defender, 'first-touch');
      if (aFt && !dFt) return { kind: 'resolved', winner: defender, note: 'first-touch-misfire' };
      if (dFt && !aFt) return { kind: 'resolved', winner: attacker, note: 'first-touch-misfire' };
    }
    return { kind: 'resolved', winner: null };
  }

  const attackerSkips = has(active, attacker, 'first-touch') || (has(active, attacker, 'golden-boot') && possession.zone === 'opponent');
  const defenderSkips = has(active, defender, 'first-touch') || has(active, defender, 'high-press');
  if (attackerSkips && !defenderSkips) return { kind: 'resolved', winner: attacker, note: has(active, attacker, 'golden-boot') ? 'golden-boot' : 'first-touch' };
  if (defenderSkips && !attackerSkips) return { kind: 'resolved', winner: defender, note: has(active, defender, 'high-press') ? 'high-press' : 'first-touch' };
  // Rule variant: both right goes to the attacker unless the defender has a card in play.
  if (RULES.attackerWinsTies && active[defender].length === 0) return { kind: 'resolved', winner: attacker, note: 'attacker-edge' };
  return { kind: 'numeric' };
}

export interface MovementMods {
  attackerSteps: number;
  /** The defender won it answering right while the attacker was wrong: one zone forward. */
  cleanSteal?: boolean;
  /** Where a defender who wins the ball starts; undefined = the plain rule (where it was won). */
  defenderZone?: AttackZone;
  /** Extra zones for a defender who wins the ball. */
  defenderSteps?: number;
  holdGround: boolean;
}

/**
 * How far the duel's winner moves with the cards in play and any Tiki-Taka run (which adds a zone to every duel its
 * owner wins, attacking or defending). `correct` is null when no question was played (a Goalkeeper Gloves save): the
 * only clean steal is the defender right and the attacker wrong.
 */
export function movementMods(
  possession: Possession,
  winner: DuelSide | null,
  active: ActiveCards,
  tikiTaka: Record<DuelSide, boolean>,
  correct: Record<DuelSide, boolean> | null,
): MovementMods {
  const attacker = possession.attacker;
  const defender: DuelSide = attacker === 'player' ? 'opponent' : 'player';
  const mods: MovementMods = { attackerSteps: 1, holdGround: false };
  if (winner === attacker) {
    if (has(active, attacker, 'screamer')) {
      mods.attackerSteps = 2;
    } else if (has(active, attacker, 'long-ball')) {
      mods.attackerSteps = possession.zone === 'own' ? 2 : 1;
    } else {
      if (has(active, attacker, 'captains-armband')) mods.attackerSteps += 1;
      if (tikiTaka[attacker]) mods.attackerSteps += 1;
    }
    // Golden Boot's shot can't be parked.
    const unstoppable = (has(active, attacker, 'golden-boot') || has(active, attacker, 'bicycle-kick')) && possession.zone === 'opponent';
    // (As a read — counters — the bus only stops a run, settled in decideDuel.)
    mods.holdGround = !RULES.counters && has(active, defender, 'park-the-bus') && !unstoppable && !has(active, attacker, 'nutmeg');
    // Rule variant: a sabotage the victim (here the attacker) beats gives them an extra zone.
    if (RULES.downsides && correct?.[attacker] && SABOTAGE_CARDS.some((id) => has(active, defender, id))) mods.attackerSteps += 1;
  } else if (winner === defender) {
    const attackerWrong = correct !== null && !correct[attacker];
    mods.cleanSteal = (attackerWrong && correct !== null && correct[defender]) || (attackerWrong && (has(active, attacker, 'bicycle-kick') || has(active, attacker, 'screamer')));
    // A lost Long Ball is won on the attacker's side at least.
    if (attackerWrong && has(active, attacker, 'long-ball')) mods.defenderZone = 'opponent';
    mods.defenderSteps = (has(active, defender, 'counter-attack') ? 1 : 0) + (tikiTaka[defender] ? 1 : 0);
    // A missed Bicycle Kick leaves him on the grass: they break one zone further (the 'faster' rule).
    if (attackerWrong && RULES.bicycle === 'faster' && has(active, attacker, 'bicycle-kick')) mods.defenderSteps += 1;
    if (RULES.downsides) {
      // A lost Armband or Tiki-Taka run leaves the space behind; a sabotage the defender beat backfires.
      if (has(active, attacker, 'captains-armband') || tikiTaka[attacker]) mods.defenderSteps += 1;
      if (correct?.[defender] && SABOTAGE_CARDS.some((id) => has(active, attacker, id))) mods.defenderSteps += 1;
    }
  }
  return mods;
}
