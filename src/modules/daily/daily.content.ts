export interface ContentSource<Row> {
  /** Changes whenever the days table changes (a seed); cheap enough to ask every few seconds. */
  fingerprint(): Promise<string>;
  load(): Promise<Row[]>;
}

export interface ContentLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ContentStore<Day> {
  /** Days in serving form; re-read from the database only when its fingerprint changes. */
  get(): Promise<ReadonlyMap<string, Day>>;
  /** The next get() re-checks the database instead of waiting out the refresh interval. */
  invalidate(): void;
}

const storedDayKeys = new WeakMap<ReadonlyMap<string, unknown>, readonly string[]>();

/** Records every stored day behind a served index, malformed ones included. */
export function rememberStoredDays(index: ReadonlyMap<string, unknown>, days: readonly string[]): void {
  storedDayKeys.set(index, days);
}

/**
 * The days the calendar runs on: every stored day, served or not, so a malformed row 404s only itself instead of
 * ending the calendar the seed considers unbroken. An index built elsewhere (tests) stands for itself.
 */
export function storedDaysOf(index: ReadonlyMap<string, unknown>): Iterable<string> {
  return storedDayKeys.get(index) ?? index.keys();
}

/**
 * A daily game's days, cached per replica and re-read only when the table's fingerprint changes. A malformed
 * row is logged and not served; a failed re-check keeps serving what was loaded.
 */
export function createDailyContentStore<Row extends { day: string }, Day>(
  source: ContentSource<Row>,
  index: (row: Row) => Day | null,
  opts: { refreshMs: number; now: () => number; log: ContentLog; label: string },
): ContentStore<Day> {
  let cached: { fingerprint: string; index: ReadonlyMap<string, Day>; checkedAt: number } | null = null;
  let inflight: Promise<ReadonlyMap<string, Day>> | null = null;

  async function refresh(): Promise<ReadonlyMap<string, Day>> {
    const fingerprint = await source.fingerprint();
    if (cached && cached.fingerprint === fingerprint) {
      cached.checkedAt = opts.now();
      return cached.index;
    }
    const days = new Map<string, Day>();
    const rows = await source.load();
    for (const row of rows) {
      const day = index(row);
      if (day) days.set(row.day, day);
      else opts.log.error({ day: row.day }, `${opts.label} day has malformed content; it is not served`);
    }
    rememberStoredDays(days, rows.map((row) => row.day));
    cached = { fingerprint, index: days, checkedAt: opts.now() };
    return days;
  }

  return {
    async get() {
      if (cached && opts.now() - cached.checkedAt < opts.refreshMs) return cached.index;
      inflight ??= refresh().finally(() => { inflight = null; });
      try {
        return await inflight;
      } catch (error) {
        if (!cached) throw error;
        opts.log.warn({ err: error }, `${opts.label} content refresh failed; serving the previous copy`);
        cached.checkedAt = opts.now();
        return cached.index;
      }
    },
    invalidate() {
      if (cached) cached.checkedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
