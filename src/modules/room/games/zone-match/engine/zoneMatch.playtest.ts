// COPY of the web's src/features/zone-match/zoneMatch.playtest.ts (one rules implementation; keep byte-identical apart from import paths).
/**
 * Ranked 2.0 (zone match) — PLAYTEST settings. NOT FINAL: these exist so the rules, cards and game modes can be tried
 * with real players and changed without touching the screens. Expected to change:
 *
 * - Every playstyle is unlocked for everyone, so every card gets played and measured. The final game starts players
 *   with a few cards and unlocks the rest.
 * - Categories are dealt at random (CATEGORY_COUNT per side). How categories are chosen may change.
 * - Card windows (once per round / before every question), the energy budget and the loadout size may change.
 *
 * The backend reads the same rules (shared engine) once the server-run version exists; until then this is client-only.
 */

import type { CardId } from './zoneMatch.cards.js';

export const PLAYTEST = {
  /** All 27 playstyles available in the loadout. Final: a starter set, the rest unlocked over time. */
  allPlaystylesUnlocked: true,
  /** Categories dealt at random, five per side. */
  randomCategories: true,
} as const;

/** The playstyles this player may put in a loadout (playtest: all of them). */
export function isPlaystyleUnlocked(id: CardId, unlocked: readonly CardId[] = []): boolean {
  return PLAYTEST.allPlaystylesUnlocked || unlocked.includes(id);
}

/**
 * Rule variants under test (simulator first, then playtests). All off = the rules as they are; the simulator switches
 * them on to measure how much card skill matters against knowledge.
 *   counters          — Park the Bus and Offside Trap become reads: they beat a movement card (Captain's Armband,
 *                       Tiki-Taka, Long Ball) outright — the defender wins the ball — and do nothing otherwise.
 *   downsides         — risky cards cost when they fail: a lost Armband / Tiki-Taka duel lets the defender break one
 *                       zone further; First Touch played wrong loses the duel even if they were wrong too; a sabotage
 *                       the victim answers right anyway gives the victim an extra zone.
 *   attackerWinsTies  — both right: the attacker wins, unless the defender has a card in play this duel (then the
 *                       number question decides) — fewer number questions, more card decisions.
 *   energy            — no one-use loadout: start with ENERGY_START⚡, earn 1⚡ per right answer (up to ENERGY_MAX),
 *                       and any playstyle in the loadout can be played again whenever it can be paid for.
 *   hiddenLoadouts    — the loadouts aren't shown at the showdown (a player only learns a card when it is played).
 *   bicycle           — Bicycle Kick (on your shot; Gloves and the Bus can't stop it; answer wrong and they steal it
 *                       clean), and the extra that sets it apart from Golden Boot:
 *                       'comeback' only when you're level or behind, and both right is a goal ·
 *                       'faster' both right: the faster answer wins it, no number question; a miss lets them break.
 */
export type BicycleRule = 'comeback' | 'faster';
export const RULES = { counters: false, downsides: false, attackerWinsTies: false, energy: false, hiddenLoadouts: false, bicycle: 'comeback' as BicycleRule };
export const ENERGY_START = 3;
export const ENERGY_MAX = 6;

export function setRules(patch: Partial<typeof RULES>) {
  Object.assign(RULES, patch);
}

export const MOVEMENT_CARDS: readonly CardId[] = ['captains-armband', 'tiki-taka', 'long-ball'];
export const SABOTAGE_CARDS: readonly CardId[] = ['floodlight-failure', 'muddy-pitch', 'fog', 'yellow-card'];
