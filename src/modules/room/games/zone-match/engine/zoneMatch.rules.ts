// COPY of the web's src/features/zone-match/zoneMatch.rules.ts (one rules implementation; keep byte-identical apart from import paths).
/**
 * Zone match rules (prototype). The pitch has three zones; the attacker moves
 * forward one zone per battle won and scores by winning a battle in the
 * opponent's side. A match is MATCH_ROUNDS rounds; a round is one possession:
 * it ends with a goal or with the ball changing hands, so possession alternates.
 *
 *   attacker's goal │ OWN SIDE │ CENTRE │ OPPONENT'S SIDE │ defender's goal
 *
 * A battle is one multiple-choice question; when both answer correctly a
 * numeric question (closest guess) decides who won it.
 *
 * - Attacker wins   → one zone forward; from the opponent's side that is a goal.
 * - Both wrong      → the ball changes hands where it was lost.
 * - Clean steal     → the defender answered right and the attacker wrong: the
 *                     defender carries it ONE zone forward from where it was
 *                     won (own half → centre, centre → the other side's half,
 *                     near the other side's goal → straight in: a `stolen` goal).
 * - Defender wins otherwise (the number tiebreak, a Goalkeeper Gloves save,
 *   an Offside Trap on a double miss) → the turn changes on the same spot.
 * - After a goal    → the ball restarts at the centre and the next round is
 *                     the other side's attack, as always: a stolen goal
 *                     costs no turn, so each side attacks MATCH_ROUNDS / 2 times.
 */

import type { DuelSide } from './numericDuel.js';

export type ZoneSide = DuelSide;

/** Where the ball is, seen from the attacker. */
export type AttackZone = 'own' | 'centre' | 'opponent';

export interface Possession {
  attacker: ZoneSide;
  zone: AttackZone;
}

/** One continuous match: 10 possessions, 5 attacks each. */
export const MATCH_ROUNDS = 10;

export const otherZoneSide = (side: ZoneSide): ZoneSide => (side === 'player' ? 'opponent' : 'player');

export type BattleOutcome =
  | { kind: 'advance'; next: Possession; roundOver: false }
  /** The attacker won but a card (Park the Bus) kept the ball where it was. */
  | { kind: 'held'; next: Possession; roundOver: false }
  /** `stolen`: the defender won the ball near the attacker's goal and scored straight away. */
  | { kind: 'goal'; scorer: ZoneSide; next: Possession; roundOver: true; stolen?: boolean }
  | { kind: 'turnover'; next: Possession; roundOver: true }
  | { kind: 'bothWrong'; next: Possession; roundOver: true };

/** Card effects on how far a battle moves the ball; the defaults are the plain rules. */
export interface BattleMods {
  /** Zones a winning attacker moves (2 = Captain's Armband, Tiki-Taka…). */
  attackerSteps?: number;
  /** The defender answered right and the attacker wrong: the steal carries the ball one zone forward. */
  cleanSteal?: boolean;
  /** The least far a defender who wins the ball gets (a lost Long Ball: at least the other side's half). */
  defenderZone?: AttackZone;
  /** Extra zones for a defender who wins the ball (Counter-Attack, Tiki-Taka); past the other side's half scores. */
  defenderSteps?: number;
  /** A winning attacker gains no ground. */
  holdGround?: boolean;
}

const ZONE_ORDER: AttackZone[] = ['own', 'centre', 'opponent'];

/** The same spot on the pitch seen from the other side: one side's own half is the other's attacking half. */
export function mirrorZone(zone: AttackZone): AttackZone {
  return ZONE_ORDER[ZONE_ORDER.length - 1 - ZONE_ORDER.indexOf(zone)];
}

/** Applies one battle's winner (null = both answered wrong) to the possession. */
export function resolveBattle(possession: Possession, winner: ZoneSide | null, mods: BattleMods = {}): BattleOutcome {
  const defender = otherZoneSide(possession.attacker);
  const lostAt = mirrorZone(possession.zone);
  if (winner === null) {
    return { kind: 'bothWrong', next: { attacker: defender, zone: lostAt }, roundOver: true };
  }
  if (winner === defender) {
    // A clean steal carries the ball one zone forward from where it was won; any other win keeps the spot (cards add).
    const stepped = ZONE_ORDER.indexOf(lostAt) + (mods.cleanSteal ? 1 : 0);
    const floor = mods.defenderZone ? ZONE_ORDER.indexOf(mods.defenderZone) : 0;
    const target = Math.max(stepped, floor) + Math.max(0, mods.defenderSteps ?? 0);
    if (target >= ZONE_ORDER.length) {
      return { kind: 'goal', scorer: defender, stolen: true, next: { attacker: defender, zone: 'centre' }, roundOver: true };
    }
    return { kind: 'turnover', next: { attacker: defender, zone: ZONE_ORDER[target] }, roundOver: true };
  }
  if (mods.holdGround) {
    return { kind: 'held', next: possession, roundOver: false };
  }
  const target = ZONE_ORDER.indexOf(possession.zone) + Math.max(1, mods.attackerSteps ?? 1);
  if (target >= ZONE_ORDER.length) {
    return { kind: 'goal', scorer: possession.attacker, next: { attacker: defender, zone: 'centre' }, roundOver: true };
  }
  return { kind: 'advance', next: { attacker: possession.attacker, zone: ZONE_ORDER[target] }, roundOver: false };
}

/** The ball's place on a pitch drawn with the player's goal on the left: 0 = player's side, 1 = centre, 2 = opponent's side. */
export function pitchColumn(possession: Possession): 0 | 1 | 2 {
  if (possession.zone === 'centre') return 1;
  const towardOpponentGoal = possession.zone === 'opponent';
  const attackerIsPlayer = possession.attacker === 'player';
  return towardOpponentGoal === attackerIsPlayer ? 2 : 0;
}

/** Where the ball is, named from the player's seat: "your side", "the centre" or "their side". */
export function pitchLabel(possession: Possession): string {
  return ['your side', 'the centre', 'their side'][pitchColumn(possession)];
}
