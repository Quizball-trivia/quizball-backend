/**
 * Shared activity model for roster bots in the house-banked mini games.
 *
 * Bots should look like the real audience, not like a fixed head-count. The
 * model turns a daily session budget into organic arrivals:
 *   - HOUR_SHARE is the measured share of human actions per Tbilisi hour on
 *     prod (28 days to 2026-09-06: user_xp_events + daily completions, bots
 *     and seed accounts excluded). Nights are quiet, lunch is the peak, and
 *     there is a real post-midnight bump.
 *   - Each day gets a seeded ±20% jitter so no two days have the same volume.
 *   - Per tick the worker draws Poisson(expected arrivals) so sessions cluster
 *     and thin out the way real traffic does.
 *
 * Daily session budgets default from the measured audience: ~195 daily active
 * humans (peak 337). Owners wanting a busier-looking mode raise
 * SYNTHETIC_ACTIVITY_DAU (e.g. 3000) and every mode scales with it.
 */
export const HOUR_SHARE: readonly number[] = [
  0.0783, 0.0489, 0.0308, 0.019, 0.016, 0.012, 0.0048, 0.0091, 0.0135, 0.0241, 0.0469, 0.0625,
  0.0695, 0.0695, 0.0649, 0.063, 0.0578, 0.0606, 0.0483, 0.0396, 0.041, 0.0402, 0.0387, 0.0411,
];

export function tbilisiHour(now = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Tbilisi' }).format(now)) % 24;
}

export function tbilisiDayKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** ±20% day-to-day volume jitter, stable within a day, different per mode. */
export function dayJitter(mode: string, now = new Date()): number {
  const rng = mulberry32(hashString(`${mode}:${tbilisiDayKey(now)}`));
  return 0.8 + rng() * 0.4;
}

/** Knuth Poisson sampler; fine for the small λ per tick we use. */
export function poisson(rng: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/** Expected new sessions in one tick for a mode with `dailySessions` sessions/day. */
export function expectedArrivals(dailySessions: number, tickMs: number, mode: string, now = new Date()): number {
  const perHour = dailySessions * HOUR_SHARE[tbilisiHour(now)] * dayJitter(mode, now);
  return (perHour * tickMs) / 3_600_000;
}

/** Derive a mode's daily session budget from the audience size when not configured explicitly. */
export function deriveDailySessions(dau: number, modeShare: number, sessionsPerPlayer: number): number {
  return Math.round(dau * modeShare * sessionsPerPlayer);
}
