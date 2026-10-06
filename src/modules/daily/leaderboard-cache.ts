import { logger } from '../../core/logger.js';

/** Coalesces a cold/expired public board per replica; personal ranks remain uncached. */
export function createLeaderboardCache<Entry>(
  load: (day: string) => Promise<{ players: number; top: Entry[] }>,
  ttlMs: number,
  now: () => number,
  { loadTimeoutMs = 5_000, abandonAfterMs = 30_000 }: { loadTimeoutMs?: number; abandonAfterMs?: number } = {},
) {
  type Board = { players: number; top: Entry[] };
  type Load = { promise: Promise<Board>; startedAt: number; generation: number; seq: number };
  type DayState = { generation: number; value?: Board; valueGeneration: number; valueSeq: number; at: number; loads: Set<Load> };
  const days = new Map<string, DayState>();
  let seq = 0;

  /** Readers wait at most `ms`; the query itself keeps running (bounded by its own statement timeout) and stays shared. */
  const withDeadline = (promise: Promise<Board>, ms: number): Promise<Board> => new Promise<Board>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Leaderboard load exceeded ${ms} ms`)), ms);
    timer.unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });

  const start = (day: string, state: DayState): Load => {
    const entry: Load = { promise: undefined as never, startedAt: now(), generation: state.generation, seq: ++seq };
    entry.promise = Promise.resolve().then(() => load(day)).then((value) => {
      // An invalidation, or a newer load that already landed, wins over this result.
      if (entry.generation === state.generation && (state.valueGeneration !== state.generation || entry.seq > state.valueSeq)) {
        Object.assign(state, { value, valueGeneration: entry.generation, valueSeq: entry.seq, at: now() });
      }
      return value;
    }).finally(() => { state.loads.delete(entry); });
    state.loads.add(entry);
    return entry;
  };

  /**
   * At most one running query per day and generation, and at most two per day: a timed-out reader leaves its query to
   * finish for the next reader rather than starting another, so a stalled database is not handed a growing pile of
   * identical work. Only a query unsettled past `abandonAfterMs` (its statement timeout is far shorter, so the
   * transport is gone) stops counting.
   */
  const loadFor = (day: string, state: DayState): Load => {
    const live: Load[] = [];
    for (const entry of state.loads) {
      if (now() - entry.startedAt < abandonAfterMs) live.push(entry);
      else {
        state.loads.delete(entry);
        logger.warn({ day, ageMs: now() - entry.startedAt }, 'Leaderboard load abandoned: unsettled past its abandon age');
      }
    }
    const newest = live.reduce<Load | undefined>((best, entry) => (!best || entry.seq > best.seq ? entry : best), undefined);
    if (newest && newest.generation === state.generation) return newest;
    if (newest && live.length >= 2) return newest;
    return start(day, state);
  };

  return {
    delete(day: string): void {
      const state = days.get(day);
      if (state) state.generation += 1;
    },
    get(day: string): Promise<Board> {
      let state = days.get(day);
      if (!state) {
        state = { generation: 0, valueGeneration: -1, valueSeq: 0, at: 0, loads: new Set() };
        days.set(day, state);
      }
      if (state.value && state.valueGeneration === state.generation && now() - state.at <= ttlMs) return Promise.resolve(state.value);
      const current = state;
      return withDeadline(loadFor(day, current).promise, loadTimeoutMs).catch((error: unknown) => {
        if (current.value) return current.value;
        throw error;
      });
    },
  };
}
