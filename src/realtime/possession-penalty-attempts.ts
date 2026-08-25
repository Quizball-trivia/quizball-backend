/**
 * The single normalizer for penalty attempt arrays. kicksTaken is
 * authoritative: the result is ALWAYS exactly kicksTaken long — canonical
 * "goals then misses" — with any real per-kick outcomes overwriting the
 * prefix. Both the Redis cache rebuild and the DB state rehydrate MUST use
 * this: two normalizers with different length contracts is what desynced
 * attempts from kicksTaken, broke the sudden-death parity check, and hung
 * shootouts.
 */
export function normalizePenaltyAttempts(params: {
  attempts: unknown;
  goals: { seat1: number; seat2: number };
  kicksTaken: { seat1: number; seat2: number };
}): { seat1: Array<'goal' | 'miss'>; seat2: Array<'goal' | 'miss'> } {
  const fromRaw = (value: unknown, goals: number, kicksTaken: number): Array<'goal' | 'miss'> => {
    const total = Math.max(0, kicksTaken);
    const result: Array<'goal' | 'miss'> = [
      ...Array.from({ length: Math.min(total, Math.max(0, goals)) }, () => 'goal' as const),
      ...Array.from({ length: Math.max(0, total - Math.max(0, goals)) }, () => 'miss' as const),
    ];
    if (Array.isArray(value)) {
      const sanitized = value.filter((entry): entry is 'goal' | 'miss' => entry === 'goal' || entry === 'miss');
      for (let i = 0; i < Math.min(sanitized.length, total); i += 1) {
        result[i] = sanitized[i];
      }
    }
    return result;
  };

  const raw = params.attempts && typeof params.attempts === 'object'
    ? params.attempts as { seat1?: unknown; seat2?: unknown }
    : {};
  return {
    seat1: fromRaw(raw.seat1, params.goals.seat1, params.kicksTaken.seat1),
    seat2: fromRaw(raw.seat2, params.goals.seat2, params.kicksTaken.seat2),
  };
}
