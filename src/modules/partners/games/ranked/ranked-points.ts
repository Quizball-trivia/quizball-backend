/** Freecroco ranked points (contract §7.1): the margin table and the terminal-cause table. Pure; the settlement
 *  service feeds it the match tally, how the match ended and the points table in force when the match started. */

export interface RankedPointsPair {
  winner: number;
  loser: number;
}

/** The editable values of contract §7.1 (CMS "Ranked points"). */
export interface RankedPointsTable {
  /** Win by 1..5 goals, then the last entry for 6 or more. */
  margins: RankedPointsPair[];
  /** A draw won on penalties (also a both-dropped draw decided on correct answers). */
  penaltyWin: RankedPointsPair;
  drawAfterPenalties: number;
  /** A stayer who was not ahead when the opponent left. */
  leftNotAhead: number;
}

/** Margin rows: by 1, 2, 3, 4, 5, and 6 or more goals. */
export const RANKED_MARGIN_ROWS = 6;
export const RANKED_POINTS_MAX_VALUE = 5000;

/** Contract §7.1 as agreed; the seeded version 1 of every partner's table. */
export const DEFAULT_RANKED_POINTS: RankedPointsTable = {
  margins: [
    { winner: 100, loser: 50 },
    { winner: 150, loser: 40 },
    { winner: 200, loser: 30 },
    { winner: 250, loser: 20 },
    { winner: 300, loser: 10 },
    { winner: 500, loser: 0 },
  ],
  penaltyWin: { winner: 100, loser: 50 },
  drawAfterPenalties: 60,
  leftNotAhead: 100,
};

/** Every problem with a table, as readable messages; empty = valid. */
export function rankedPointsProblems(table: RankedPointsTable): string[] {
  const problems: string[] = [];
  const check = (label: string, value: number) => {
    if (!Number.isInteger(value) || value < 0 || value > RANKED_POINTS_MAX_VALUE) {
      problems.push(`${label} must be a whole number from 0 to ${RANKED_POINTS_MAX_VALUE}`);
    }
  };
  const pair = (label: string, p: RankedPointsPair) => {
    check(`${label} winner`, p.winner);
    check(`${label} loser`, p.loser);
    if (p.winner < p.loser) problems.push(`${label}: winner points must be at least the loser points`);
  };
  if (table.margins.length !== RANKED_MARGIN_ROWS) {
    problems.push(`margins must have ${RANKED_MARGIN_ROWS} rows (by 1..5 goals, then 6 or more)`);
  }
  table.margins.forEach((p, i) => pair(i === RANKED_MARGIN_ROWS - 1 ? 'By 6 or more goals' : `By ${i + 1} goal${i ? 's' : ''}`, p));
  pair('Draw won on penalties', table.penaltyWin);
  check('Draw after penalties', table.drawAfterPenalties);
  check('Opponent left, not ahead', table.leftNotAhead);
  return problems;
}

/** The most one play can score under this table (the per-play cap and the "up to" shown to players). */
export function rankedMaxScore(table: RankedPointsTable): number {
  return Math.max(
    ...table.margins.map((p) => p.winner),
    table.penaltyWin.winner,
    table.drawAfterPenalties,
    table.leftNotAhead,
  );
}

export function marginPoints(margin: number, table: RankedPointsTable): RankedPointsPair {
  if (!Number.isInteger(margin) || margin < 1) throw new Error(`margin must be a positive integer, got ${margin}`);
  const { winner, loser } = table.margins[Math.min(margin, RANKED_MARGIN_ROWS) - 1]!;
  return { winner, loser };
}

export interface RankedSideTally {
  userId: string;
  goals: number;
  penaltyGoals: number;
  correctAnswers: number;
}

/**
 * How the match ended, in the order of the contract's terminal-cause table (the first matching row applies):
 * - server_failure: no events, both plays returned.
 * - both_dropped: decided by goals, then penalties, then correct answers; level → cancelled, both returned.
 * - early_leave: exactly one player left during the first two questions → cancelled; the leaver's play is used,
 *   the opponent's returned.
 * - left: exactly one player left later (or dropped out for good, or was blocked): leaver 0, opponent by margin
 *   or 100 if not ahead.
 * - natural: played to the end (incl. the shootout).
 */
export type RankedTerminalCause =
  | { kind: 'server_failure' }
  | { kind: 'both_dropped' }
  | { kind: 'early_leave'; leaverUserId: string }
  | { kind: 'left'; leaverUserId: string }
  | { kind: 'natural' };

export type RankedSideResult =
  | { kind: 'score'; score: number; outcome: 'win' | 'loss' | 'draw' }
  | { kind: 'cancel'; refund: boolean };

function decided(
  winner: RankedSideTally,
  loser: RankedSideTally,
  byPenalties: boolean,
  table: RankedPointsTable,
): Map<string, RankedSideResult> {
  const points = byPenalties ? table.penaltyWin : marginPoints(winner.goals - loser.goals, table);
  return new Map<string, RankedSideResult>([
    [winner.userId, { kind: 'score', score: points.winner, outcome: 'win' }],
    [loser.userId, { kind: 'score', score: points.loser, outcome: 'loss' }],
  ]);
}

function both(a: RankedSideTally, b: RankedSideTally, result: RankedSideResult): Map<string, RankedSideResult> {
  return new Map([[a.userId, result], [b.userId, result]]);
}

/** Points (or cancellation) for both sides; bots are scored too and simply never get an event. */
export function rankedPartnerResult(
  sides: readonly [RankedSideTally, RankedSideTally],
  cause: RankedTerminalCause,
  table: RankedPointsTable,
): Map<string, RankedSideResult> {
  const [a, b] = sides;
  switch (cause.kind) {
    case 'server_failure':
      return both(a, b, { kind: 'cancel', refund: true });
    case 'early_leave': {
      const leaver = cause.leaverUserId === a.userId ? a : b;
      const stayer = leaver === a ? b : a;
      return new Map<string, RankedSideResult>([
        [leaver.userId, { kind: 'cancel', refund: false }],
        [stayer.userId, { kind: 'cancel', refund: true }],
      ]);
    }
    case 'left': {
      const leaver = cause.leaverUserId === a.userId ? a : b;
      const stayer = leaver === a ? b : a;
      const ahead = stayer.goals - leaver.goals;
      return new Map<string, RankedSideResult>([
        [leaver.userId, { kind: 'score', score: 0, outcome: 'loss' }],
        [stayer.userId, { kind: 'score', score: ahead > 0 ? marginPoints(ahead, table).winner : table.leftNotAhead, outcome: 'win' }],
      ]);
    }
    case 'both_dropped': {
      if (a.goals !== b.goals) return a.goals > b.goals ? decided(a, b, false, table) : decided(b, a, false, table);
      if (a.penaltyGoals !== b.penaltyGoals) return a.penaltyGoals > b.penaltyGoals ? decided(a, b, true, table) : decided(b, a, true, table);
      // Level on goals and penalties but apart on correct answers: scored like a draw won on penalties.
      if (a.correctAnswers !== b.correctAnswers) {
        return a.correctAnswers > b.correctAnswers ? decided(a, b, true, table) : decided(b, a, true, table);
      }
      return both(a, b, { kind: 'cancel', refund: true });
    }
    case 'natural': {
      if (a.goals !== b.goals) return a.goals > b.goals ? decided(a, b, false, table) : decided(b, a, false, table);
      if (a.penaltyGoals !== b.penaltyGoals) return a.penaltyGoals > b.penaltyGoals ? decided(a, b, true, table) : decided(b, a, true, table);
      return both(a, b, { kind: 'score', score: table.drawAfterPenalties, outcome: 'draw' });
    }
  }
}
