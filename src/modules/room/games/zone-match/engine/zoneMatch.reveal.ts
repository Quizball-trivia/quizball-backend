// COPY of the web's src/features/zone-match/zoneMatch.reveal.ts (one rules implementation; keep byte-identical apart from import paths).
/**
 * The showdown's playstyle reveal, timed so every card can be followed: your three playstyles land on your card one at
 * a time, each playing its whole reaction before the next; then the opponent's three the same way; then time to read
 * both loadouts. Pure (the machine schedules the step's end from it; the screen lands the cards on it).
 */

import type { CardId } from './zoneMatch.cards.js';
import type { ZoneSide as DuelSide } from './zoneMatch.rules.js';

/** How long each card's reaction plays (s). */
export const CARD_REACTION_S: Record<CardId, number> = {
  'first-touch': 2.7,
  'fifty-fifty': 1.4,
  'golden-boot': 2.7,
  'captains-armband': 2.2,
  'second-ball': 2.9,
  'floodlight-failure': 1.6,
  'muddy-pitch': 2.6,
  fog: 2.8,
  'yellow-card': 2.2,
  'offside-trap': 2.3,
  'var-review': 1.7,
  'goalkeeper-gloves': 2.5,
  'park-the-bus': 2.6,
  'shin-pads': 2.2,
  'long-ball': 1.6,
  'counter-attack': 1.6,
  substitution: 1.8,
  'home-advantage': 2.6,
  'dummy-run': 2.0,
  'tiki-taka': 2.9,
  // The newer cards (zoneMatch.cardMoves).
  nutmeg: 2.6,
  'bicycle-kick': 2.6,
  'high-press': 2.6,
  'time-wasting': 2.85,
  'super-sub': 2.6,
  feint: 2.2,
  'poker-face': 2.2,
  screamer: 2.4,
};

/** The phase curtain first, then a beat before the first card. */
const START_MS = 2900;
/** A pause after each card's reaction before the next one lands. */
const BETWEEN_MS = 450;
/** Once all six have landed: time to read and remember them. */
export const REVEAL_READ_MS = 5000;

export interface RevealSchedule {
  /** When each card lands, per side (ms from the start of the step). */
  landAt: Record<DuelSide, number[]>;
  /** When the reading time starts (every card has landed and finished its reaction). */
  readFrom: number;
  /** The step's whole length. */
  total: number;
}

export function revealSchedule(decks: Record<DuelSide, readonly CardId[]>): RevealSchedule {
  let at = START_MS;
  const land = (cards: readonly CardId[]) =>
    cards.map((card) => {
      const t = at;
      at += CARD_REACTION_S[card] * 1000 + BETWEEN_MS;
      return t;
    });
  const player = land(decks.player);
  const opponent = land(decks.opponent);
  return { landAt: { player, opponent }, readFrom: at, total: at + REVEAL_READ_MS };
}
