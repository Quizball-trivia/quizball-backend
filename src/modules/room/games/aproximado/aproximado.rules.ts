// COPY of the web's src/features/aproximado/aproximado.rules.ts (one rules implementation; keep byte-identical apart from import paths).
/**
 * Stat Sniper / "Aproximado futbolero" as a 1v1 or 2–6 player room: pure rules, no I/O. The playground runs them locally
 * against bots; the room runtime must use this same tested implementation (shared), not a hand-written mirror
 * (docs/ROOM-GAMES-PLAN-V2.md §3, docs/STAT-SNIPER-MODES-PLAN.md).
 */

export type Scoring = "podium" | "closest";
export type SeatStatus = "in" | "away" | "withdrawn";

export interface AproximadoQuestion {
  id: string;
  kind: "fee" | "value" | "goals" | "attendance" | "height" | "apps" | "age";
  prompt: string;
  unit: string;
  /** Decimals a guess may carry (0 for goals, 1 for €M fees); 0–3. */
  precision: number;
  /** A guess within this distance counts as exact (+1). Private: never sent before the reveal. */
  exactWithin: number;
  value: number;
}

export interface RoundEntry { seat: number; guess: number | null; diff: number | null; rank: number | null; points: number; exact: boolean }
export interface RoundResult { value: number; entries: RoundEntry[]; winners: number[] }

const MAX_PRECISION = 3;
const validPrecision = (p: number) => (Number.isInteger(p) && p >= 0 && p <= MAX_PRECISION ? p : 0);
/** Values and guesses as whole units of the question's precision, so ties and the exact window never meet float noise. */
const units = (v: number, precision: number) => Math.round(v * 10 ** validPrecision(precision));

/**
 * One round's points. Closest first; equal distance shares a rank (and the higher points). Podium: the top rank gets
 * min(3, N−1) and each rank below one less, down to 0. Closest: the top rank gets 1. Exact adds 1 either way. No guess = 0.
 * N = the seats in the round (the admitted roster), answered or not.
 */
export function scoreRound(guesses: ReadonlyArray<number | null>, value: number, exactWithin: number, scoring: Scoring, precision = 0): RoundResult {
  const n = guesses.length;
  const target = units(value, precision);
  // Rounded DOWN to the precision: a ±0.5 window on a whole-number question means "exact" only, never ±1.
  const window = Math.floor(Math.max(0, exactWithin) * 10 ** validPrecision(precision) + 1e-9);
  const dist = guesses.map((g) => (g === null ? null : Math.abs(units(g, precision) - target)));
  const answered = dist.map((d, seat) => ({ seat, d })).filter((x): x is { seat: number; d: number } => x.d !== null).sort((a, b) => a.d - b.d);
  const rankOf = new Map<number, number>();
  answered.forEach((x, i) => rankOf.set(x.seat, i > 0 && x.d === answered[i - 1].d ? rankOf.get(answered[i - 1].seat)! : i + 1));
  const top = scoring === "podium" ? Math.min(3, n - 1) : 1;
  const scale = 10 ** validPrecision(precision);
  const entries = guesses.map((guess, seat): RoundEntry => {
    const d = dist[seat];
    const rank = rankOf.get(seat) ?? null;
    const exact = d !== null && d <= window;
    const base = rank === null ? 0 : Math.max(0, top - (rank - 1));
    return { seat, guess, diff: d === null ? null : d / scale, rank, points: base + (exact ? 1 : 0), exact };
  });
  const winners = entries.filter((e) => e.rank === 1).map((e) => e.seat);
  return { value, entries, winners };
}

export interface Standing { seat: number; points: number; roundWins: number; totalError: number; answered: number; place: number }

/**
 * Error of one guess as a share of the value, capped at 1 (100 %): a wild guess and no answer both cost 1, so skipping can
 * never beat answering. The same share in €M or €k gives the same error (unit-free).
 */
export const roundError = (diff: number | null, value: number) => (diff === null ? 1 : Math.min(1, diff / Math.max(Math.abs(value), Number.EPSILON)));

/** Final order: in-play seats before withdrawn ones, then points, then round wins, then smaller total error. Equal on all = shared place. */
export function standings(seats: number, results: readonly RoundResult[], withdrawn: ReadonlySet<number> = new Set()): Standing[] {
  const rows: Standing[] = Array.from({ length: seats }, (_, seat) => ({ seat, points: 0, roundWins: 0, totalError: 0, answered: 0, place: 0 }));
  for (const r of results) {
    for (const e of r.entries) {
      rows[e.seat].points += e.points;
      if (r.winners.includes(e.seat)) rows[e.seat].roundWins += 1;
      rows[e.seat].totalError += roundError(e.diff, r.value);
      if (e.diff !== null) rows[e.seat].answered += 1;
    }
  }
  // One comparison key for both the order and the shared places (error rounded to 1e-6, so no chained "almost equal").
  const key = (s: Standing) => [withdrawn.has(s.seat) ? 1 : 0, -s.points, -s.roundWins, Math.round(s.totalError * 1e6)];
  const cmp = (a: Standing, b: Standing) => { const ka = key(a); const kb = key(b); for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i]; return 0; };
  const sorted = [...rows].sort((a, b) => cmp(a, b) || a.seat - b.seat);
  sorted.forEach((s, i) => { s.place = i > 0 && cmp(sorted[i - 1], s) === 0 ? sorted[i - 1].place : i + 1; });
  return sorted;
}

export const MAX_GUESS = 10_000_000;

/**
 * Typed text → a guess, or null when it is not one unambiguous number. Strict on purpose (the first guess is final):
 * - digits, with at most one decimal separator ("," or ".") and optional thousands grouping (spaces, or the other
 *   separator) in groups of exactly three: "74 500", "74.500" (precision 0), "1.234,5", "1,234.5";
 * - a lone separator followed by exactly three digits is grouping only when the question takes no decimals;
 * - more decimals than the question takes are refused, unless they are trailing zeros ("64,50" → 64.5);
 * - no signs, exponents, or values above MAX_GUESS.
 */
export function parseGuess(raw: string, precision: number): number | null {
  if (!Number.isInteger(precision) || precision < 0 || precision > MAX_PRECISION) return null;
  const text = raw.trim().replace(/[\u00a0\u202f]/g, " ");
  if (!/^[0-9][0-9 .,]*$/.test(text) || /[ .,]$/.test(text)) return null;
  // Grouping is one style per number (spaces, dots or commas), always 1–3 digits then groups of exactly 3, and only in
  // the whole part; it is checked on the text as typed, before any separator is removed.
  const grouped = (whole: string, sep: string) => new RegExp(`^\\d{1,3}(?:${sep === " " ? " " : `\\${sep}`}\\d{3})+$`).test(whole);
  const spaces = text.includes(" ");
  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  let whole = text;
  let frac = "";
  if (spaces) {
    // Space grouping: the decimal mark (if any) is the single dot or comma, after the last group.
    if (dots + commas > 1) return null;
    const mark = dots ? "." : commas ? "," : null;
    if (mark) { whole = text.slice(0, text.indexOf(mark)); frac = text.slice(text.indexOf(mark) + 1); }
    if (!grouped(whole, " ") || frac.includes(" ")) return null;
    whole = whole.replace(/ /g, "");
  } else if (dots && commas) {
    const decimal = text.lastIndexOf(".") > text.lastIndexOf(",") ? "." : ",";
    const group = decimal === "." ? "," : ".";
    if ((decimal === "." ? dots : commas) !== 1) return null;
    whole = text.slice(0, text.lastIndexOf(decimal)); frac = text.slice(text.lastIndexOf(decimal) + 1);
    if (!grouped(whole, group)) return null;
    whole = whole.replace(new RegExp(`\\${group}`, "g"), "");
  } else if (dots + commas > 1) {
    const sep = dots ? "." : ",";
    if (!grouped(text, sep)) return null;
    whole = text.replace(new RegExp(`\\${sep}`, "g"), "");
  } else if (dots + commas === 1) {
    const sep = dots ? "." : ",";
    const [before, after] = text.split(sep);
    if (precision === 0 && after.length === 3 && /^\d{1,3}$/.test(before)) whole = before + after;
    else { whole = before; frac = after; }
  }
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) return null;
  const extra = frac.slice(precision);
  if (extra && !/^0+$/.test(extra)) return null;
  const value = Number(`${whole}.${frac.slice(0, precision) || "0"}`);
  return Number.isFinite(value) && value <= MAX_GUESS ? value : null;
}

export const ROUND_MS = 20_000;
export const REVEAL_MS = 6_000;
export const ROUNDS = 10;
