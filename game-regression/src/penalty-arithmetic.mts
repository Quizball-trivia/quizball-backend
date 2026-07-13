export type PenaltyAttempt = 'goal' | 'miss';
export type PenaltySeat = 1 | 2;

export interface PenaltyAttempts {
  seat1: PenaltyAttempt[];
  seat2: PenaltyAttempt[];
}

export interface PenaltyShootoutInput {
  attempts?: unknown;
  kicksTaken?: unknown;
  round?: unknown;
  suddenDeath?: unknown;
}

export interface PenaltyShootoutArithmetic {
  attempts: PenaltyAttempts;
  kicksTaken: { seat1: number; seat2: number };
  goals: { seat1: number; seat2: number };
  totalKicks: number;
  winnerSeat: PenaltySeat | null;
  decisionKickCount: number | null;
  suddenDeathReached: boolean;
  expectedRound: number;
  errors: string[];
}

function isAttempt(value: unknown): value is PenaltyAttempt {
  return value === 'goal' || value === 'miss';
}

function seatAttempts(value: unknown): PenaltyAttempt[] {
  return Array.isArray(value) ? value.filter(isAttempt) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function countGoals(attempts: PenaltyAttempt[]): number {
  return attempts.filter((attempt) => attempt === 'goal').length;
}

function recordedKicks(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

function nextOrderedAttempt(attempts: PenaltyAttempts, kickIndex: number): { seat: PenaltySeat; result: PenaltyAttempt } | null {
  const seat: PenaltySeat = kickIndex % 2 === 0 ? 1 : 2;
  const perSeatIndex = Math.floor(kickIndex / 2);
  const result = seat === 1 ? attempts.seat1[perSeatIndex] : attempts.seat2[perSeatIndex];
  return result ? { seat, result } : null;
}

export function normalizePenaltyAttempts(input: unknown): PenaltyAttempts {
  const raw = asRecord(input);
  return {
    seat1: seatAttempts(raw.seat1),
    seat2: seatAttempts(raw.seat2),
  };
}

export function computePenaltyShootout(input: PenaltyShootoutInput): PenaltyShootoutArithmetic {
  const attempts = normalizePenaltyAttempts(input.attempts);
  const kicksTaken = {
    seat1: recordedKicks(asRecord(input.kicksTaken).seat1, attempts.seat1.length),
    seat2: recordedKicks(asRecord(input.kicksTaken).seat2, attempts.seat2.length),
  };
  const errors: string[] = [];
  // Malformed state must surface as errors, not silently normalize into a
  // plausible recompute — invalid tokens dropped by seatAttempts or
  // non-numeric counters would otherwise pass the consistency checks below.
  const rawAttempts = asRecord(input.attempts);
  for (const seat of ['seat1', 'seat2'] as const) {
    const raw = rawAttempts[seat];
    if (raw !== undefined && !Array.isArray(raw)) {
      errors.push(`${seat} attempts is not an array`);
    } else if (Array.isArray(raw)) {
      const invalid = raw.filter((token) => !isAttempt(token)).length;
      if (invalid > 0) errors.push(`${seat} attempts contains ${invalid} invalid token(s)`);
    }
    const rawKicks = asRecord(input.kicksTaken)[seat];
    if (rawKicks !== undefined && (!Number.isFinite(Number(rawKicks)) || Number(rawKicks) < 0 || !Number.isInteger(Number(rawKicks)))) {
      errors.push(`${seat} kicksTaken is malformed: ${String(rawKicks)}`);
    }
  }
  if (attempts.seat1.length !== kicksTaken.seat1) {
    errors.push(`seat1 attempts length ${attempts.seat1.length} != kicksTaken ${kicksTaken.seat1}`);
  }
  if (attempts.seat2.length !== kicksTaken.seat2) {
    errors.push(`seat2 attempts length ${attempts.seat2.length} != kicksTaken ${kicksTaken.seat2}`);
  }
  if (Math.abs(kicksTaken.seat1 - kicksTaken.seat2) > 1) {
    errors.push(`kick parity invalid: seat1=${kicksTaken.seat1} seat2=${kicksTaken.seat2}`);
  }
  if (kicksTaken.seat2 > kicksTaken.seat1) {
    errors.push(`seat2 has more kicks than seat1: seat1=${kicksTaken.seat1} seat2=${kicksTaken.seat2}`);
  }

  let seat1Kicks = 0;
  let seat2Kicks = 0;
  let seat1Goals = 0;
  let seat2Goals = 0;
  let suddenDeath = false;
  let winnerSeat: PenaltySeat | null = null;
  let decisionKickCount: number | null = null;
  const totalKicks = attempts.seat1.length + attempts.seat2.length;

  for (let kickIndex = 0; kickIndex < totalKicks; kickIndex += 1) {
    const ordered = nextOrderedAttempt(attempts, kickIndex);
    if (!ordered) {
      errors.push(`missing alternating attempt at kick ${kickIndex + 1}`);
      break;
    }
    if (ordered.seat === 1) {
      seat1Kicks += 1;
      if (ordered.result === 'goal') seat1Goals += 1;
    } else {
      seat2Kicks += 1;
      if (ordered.result === 'goal') seat2Goals += 1;
    }

    if (suddenDeath) {
      if (seat1Kicks === seat2Kicks && seat1Goals !== seat2Goals) {
        winnerSeat = seat1Goals > seat2Goals ? 1 : 2;
        decisionKickCount = kickIndex + 1;
        break;
      }
      continue;
    }

    const rem1 = Math.max(0, 5 - seat1Kicks);
    const rem2 = Math.max(0, 5 - seat2Kicks);
    if (seat1Goals > seat2Goals + rem2) {
      winnerSeat = 1;
      decisionKickCount = kickIndex + 1;
      break;
    }
    if (seat2Goals > seat1Goals + rem1) {
      winnerSeat = 2;
      decisionKickCount = kickIndex + 1;
      break;
    }
    if (seat1Kicks >= 5 && seat2Kicks >= 5) {
      if (seat1Goals !== seat2Goals) {
        winnerSeat = seat1Goals > seat2Goals ? 1 : 2;
        decisionKickCount = kickIndex + 1;
        break;
      }
      suddenDeath = true;
    }
  }

  const expectedRound = winnerSeat ? (decisionKickCount ?? totalKicks) : totalKicks + 1;
  const round = Number(input.round);
  if (Number.isFinite(round) && Math.trunc(round) !== expectedRound) {
    errors.push(`round ${Math.trunc(round)} != expected ${expectedRound}`);
  }
  if (typeof input.suddenDeath === 'boolean' && input.suddenDeath !== suddenDeath) {
    errors.push(`suddenDeath ${input.suddenDeath} != expected ${suddenDeath}`);
  }
  if (decisionKickCount !== null && totalKicks > decisionKickCount) {
    errors.push(`attempts continued after decision: decisionKick=${decisionKickCount} totalKicks=${totalKicks}`);
  }

  return {
    attempts,
    kicksTaken,
    goals: {
      seat1: countGoals(attempts.seat1),
      seat2: countGoals(attempts.seat2),
    },
    totalKicks,
    winnerSeat,
    decisionKickCount,
    suddenDeathReached: suddenDeath,
    expectedRound,
    errors,
  };
}

export function penaltyWinnerUserId(
  players: Array<{ user_id?: string; userId?: string; seat?: number }>,
  winnerSeat: PenaltySeat | null,
): string | null {
  if (!winnerSeat) return null;
  return players.find((player) => player.seat === winnerSeat)?.user_id
    ?? players.find((player) => player.seat === winnerSeat)?.userId
    ?? null;
}
