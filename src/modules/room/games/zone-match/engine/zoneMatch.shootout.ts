// COPY of the web's src/features/zone-match/zoneMatch.shootout.ts (one rules implementation; keep byte-identical apart from import paths).
/**
 * The penalty shootout that decides a drawn match, with Ranked 1.0's rules (backend `possession-resolution.ts`):
 * kicks alternate (the side that kicked off shoots first, the other keeps goal), both answer the same question, and the
 * kick is a goal when the shooter is right and the keeper wrong, or both are right and the shooter was faster (more
 * points). Level points is a save, both wrong a miss. Five kicks each, ending early once one side can't catch up; level
 * after that, sudden death in pairs until one scores and the other doesn't. Pure.
 */

import type { ZoneSide as DuelSide } from './zoneMatch.rules.js';

export const SHOOTOUT_KICKS_EACH = 5;
/** Ranked 1.0's points: 10 per whole second left (after a short grace), 0 for a wrong answer. */
const GRACE_MS = 500;

export type KickResult = 'goal' | 'saved' | 'missed';

export interface Kick {
  shooter: DuelSide;
  result: KickResult;
  points: Record<DuelSide, number>;
}

const other = (side: DuelSide): DuelSide => (side === 'player' ? 'opponent' : 'player');

export function answerPoints(correct: boolean, timeMs: number | null, questionMs: number): number {
  if (!correct || timeMs === null) return 0;
  const clamped = Math.min(Math.max(timeMs, 0), questionMs);
  const remaining = Math.max(0, questionMs - Math.max(0, clamped - GRACE_MS));
  return Math.ceil(remaining / 1000) * 10;
}

/** One kick: who shot, and how it went given both answers' points. */
export function resolveKick(shooter: DuelSide, points: Record<DuelSide, number>): Kick {
  const keeper = other(shooter);
  const result: KickResult =
    points[shooter] > points[keeper] ? 'goal' : points[shooter] === 0 && points[keeper] === 0 ? 'missed' : 'saved';
  return { shooter, result, points };
}

/** Who shoots the next kick: the opener, then alternating. */
export function nextShooter(kicks: Kick[], opener: DuelSide): DuelSide {
  return kicks.length % 2 === 0 ? opener : other(opener);
}

export function shootoutGoals(kicks: Kick[]): Record<DuelSide, number> {
  const goals = { player: 0, opponent: 0 };
  for (const kick of kicks) if (kick.result === 'goal') goals[kick.shooter] += 1;
  return goals;
}

/** The winner once it's decided, else null (keep kicking). */
export function shootoutWinner(kicks: Kick[], opener: DuelSide): DuelSide | null {
  const goals = shootoutGoals(kicks);
  const taken = { player: 0, opponent: 0 };
  for (const kick of kicks) taken[kick.shooter] += 1;
  const second = other(opener);
  if (taken[opener] <= SHOOTOUT_KICKS_EACH && taken[second] <= SHOOTOUT_KICKS_EACH) {
    // Regulation: over as soon as one side can't catch up with the kicks it has left.
    const left = { player: SHOOTOUT_KICKS_EACH - taken.player, opponent: SHOOTOUT_KICKS_EACH - taken.opponent };
    if (goals.player > goals.opponent + left.opponent) return 'player';
    if (goals.opponent > goals.player + left.player) return 'opponent';
    return null;
  }
  // Sudden death: decided after a full pair that ends unequal.
  if (taken[opener] !== taken[second]) return null;
  if (goals.player === goals.opponent) return null;
  return goals.player > goals.opponent ? 'player' : 'opponent';
}

export function isSuddenDeath(kicks: Kick[]): boolean {
  return kicks.length >= SHOOTOUT_KICKS_EACH * 2;
}
