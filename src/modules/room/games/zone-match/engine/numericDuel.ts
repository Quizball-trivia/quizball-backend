// COPY of the web's src/features/numeric-question/numericDuel.ts (one rules implementation; keep byte-identical apart from import paths).
/**
 * Who wins a 1v1 numeric question ("closest guess wins"). Pure, so the dev harness and tests use the exact rules the
 * server runs:
 *
 * 1. Only one player answered → they win ("onlyAnswer").
 * 2. Smaller distance to the answer wins ("closer"). Distances are compared in whole units of the question's
 *    precision, so float noise never decides a duel.
 * 3. Same distance → whoever locked in first wins ("faster").
 * 4. Nobody answered, or the same distance at the same instant → a coin flip ("coinFlip").
 */

export type DuelSide = 'player' | 'opponent';

export interface DuelGuess {
  value: number | null;
  /** When the guess was locked in (ms since epoch); null when there is no guess. */
  lockedAtMs: number | null;
}

export type DuelReason = 'closer' | 'faster' | 'onlyAnswer' | 'coinFlip';

export interface DuelOutcome {
  winner: DuelSide;
  reason: DuelReason;
  /** Absolute distance from the answer per side; null when that side did not answer. */
  diffs: Record<DuelSide, number | null>;
}

export const otherSide = (side: DuelSide): DuelSide => (side === 'player' ? 'opponent' : 'player');

export function decideNumericDuel(
  answer: number,
  precision: number,
  guesses: Record<DuelSide, DuelGuess>,
  coinFlip: () => DuelSide,
): DuelOutcome {
  const scale = 10 ** Math.max(0, Math.min(3, Math.floor(precision)));
  const distance = (guess: number | null) =>
    guess === null ? null : Math.abs(Math.round(guess * scale) - Math.round(answer * scale));
  const units: Record<DuelSide, number | null> = {
    player: distance(guesses.player.value),
    opponent: distance(guesses.opponent.value),
  };
  const diffs: Record<DuelSide, number | null> = {
    player: units.player === null ? null : units.player / scale,
    opponent: units.opponent === null ? null : units.opponent / scale,
  };

  if (units.player === null && units.opponent === null) return { winner: coinFlip(), reason: 'coinFlip', diffs };
  if (units.player === null || units.opponent === null) {
    return { winner: units.player === null ? 'opponent' : 'player', reason: 'onlyAnswer', diffs };
  }
  if (units.player !== units.opponent) {
    return { winner: units.player < units.opponent ? 'player' : 'opponent', reason: 'closer', diffs };
  }

  const playerAt = guesses.player.lockedAtMs ?? Number.POSITIVE_INFINITY;
  const opponentAt = guesses.opponent.lockedAtMs ?? Number.POSITIVE_INFINITY;
  if (playerAt !== opponentAt) return { winner: playerAt < opponentAt ? 'player' : 'opponent', reason: 'faster', diffs };
  return { winner: coinFlip(), reason: 'coinFlip', diffs };
}
