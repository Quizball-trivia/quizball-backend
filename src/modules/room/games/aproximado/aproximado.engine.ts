// COPY of the web's src/features/aproximado/aproximado.engine.ts (one rules implementation; keep byte-identical apart from import paths).
/**
 * The round and seat state machine of a Stat Sniper room: pure (time comes in as `now`), no I/O. The playground's bot
 * match runs on it; the server room runtime uses the same module (docs/STAT-SNIPER-MODES-PLAN.md, "one rules
 * implementation"). Rules: docs/ROOM-GAMES-PLAN-V2.md §2 seat rules + §3.
 */
import { MAX_GUESS, REVEAL_MS, ROUND_MS, ROUNDS, scoreRound, standings, type AproximadoQuestion, type RoundResult, type Scoring, type SeatStatus, type Standing } from "./aproximado.rules.js";

export const INTRO_MS = 3_000;
/** A deadline this far overdue is an outage (server or database stalled): the round gets a fresh window, nobody is charged. */
export const OUTAGE_MS = 5_000;
/** Rounds in a row without a guess after which a seat is idle (the early close stops waiting for it). */
export const IDLE_AFTER = 2;

export interface EngineConfig {
  questions: readonly AproximadoQuestion[];
  scoring: Scoring;
  rounds?: number;
  roundMs?: number;
  revealMs?: number;
  introMs?: number;
}

export type EnginePhase = "intro" | "guess" | "reveal" | "over" | "cancelled";

export interface EngineState {
  phase: EnginePhase;
  /** 0-based question index. */
  round: number;
  /** When the current phase ends (ms epoch, server time). */
  deadline: number;
  /** This round's guesses per seat (hidden from other seats until the reveal). */
  guesses: Array<number | null>;
  results: RoundResult[];
  status: SeatStatus[];
  /** Rounds in a row without a guess, per seat. */
  missed: number[];
}

export type GuessError = "not_open" | "already_answered" | "withdrawn" | "invalid";

const opt = (cfg: EngineConfig) => ({
  rounds: Math.min(cfg.rounds ?? ROUNDS, cfg.questions.length),
  roundMs: cfg.roundMs ?? ROUND_MS,
  revealMs: cfg.revealMs ?? REVEAL_MS,
  introMs: cfg.introMs ?? INTRO_MS,
});

/** The admitted roster (2–6 seats, frozen after the ready gate) starts with the intro. */
export function startMatch(seats: number, cfg: EngineConfig, now: number): EngineState {
  if (seats < 2 || seats > 6) throw new Error("A room match needs 2 to 6 admitted seats");
  return { phase: "intro", round: 0, deadline: now + opt(cfg).introMs, guesses: Array(seats).fill(null), results: [], status: Array(seats).fill("in"), missed: Array(seats).fill(0) };
}

export const isIdle = (s: EngineState, seat: number) => s.missed[seat] >= IDLE_AFTER;
/** Seats the early close waits for: in (connected), not idle. */
export const eligibleSeats = (s: EngineState) => s.status.flatMap((st, seat) => (st === "in" && !isIdle(s, seat) ? [seat] : []));
const withdrawn = (s: EngineState) => new Set(s.status.flatMap((st, i) => (st === "withdrawn" ? [i] : [])));

/** Fewer than two seats left in → the match ends now: a result once a round was revealed, else cancelled. */
function settleTerminal(s: EngineState): EngineState {
  if (s.phase === "over" || s.phase === "cancelled") return s;
  const live = s.status.filter((st) => st !== "withdrawn").length;
  if (live >= 2) return s;
  return { ...s, phase: live === 0 || s.results.length === 0 ? "cancelled" : "over" };
}

/** True when the guess is a finite, non-negative number within the bound, carrying no more decimals than the question. */
export function validGuess(value: number, precision: number): boolean {
  if (!Number.isInteger(precision) || precision < 0 || precision > 3) return false;
  if (!Number.isFinite(value) || value < 0 || value > MAX_GUESS) return false;
  return Number(value.toFixed(precision)) === value;
}

/** A seat's guess. The first accepted guess is final; a guess stands even if the seat later leaves. */
export function submitGuess(s: EngineState, cfg: EngineConfig, seat: number, value: number, now: number): { state: EngineState; error?: GuessError } {
  // Same boundary as tick(): at the deadline the question is closed, whichever runs first.
  if (s.phase !== "guess" || now >= s.deadline) return { state: s, error: "not_open" };
  if (s.status[seat] === "withdrawn") return { state: s, error: "withdrawn" };
  if (s.guesses[seat] !== null) return { state: s, error: "already_answered" };
  if (!validGuess(value, cfg.questions[s.round].precision)) return { state: s, error: "invalid" };
  const guesses = s.guesses.map((g, i) => (i === seat ? value : g));
  // A guess clears idle at once (the seat is back in the early-close set).
  return { state: { ...s, guesses, missed: s.missed.map((m, i) => (i === seat ? 0 : m)) } };
}

export type SeatChange = { seat: number; change: "away" | "back" | "leave" };

/**
 * Seat changes that arrive together (applied in order, withdrawal absorbing), then ONE terminal check: three players
 * leaving in the same update all count, so everyone leaving cancels instead of crowning whoever was processed last.
 */
export function seatsChanged(s: EngineState, changes: readonly SeatChange[]): EngineState {
  if (s.phase === "over" || s.phase === "cancelled") return s;
  const status = [...s.status];
  for (const { seat, change } of changes) {
    if (status[seat] === "withdrawn") continue;
    status[seat] = change === "leave" ? "withdrawn" : change === "away" ? "away" : "in";
  }
  return settleTerminal({ ...s, status });
}

/** One seat's connection or membership changed. Withdrawal is final and may end the match on the spot. */
export const seatChanged = (s: EngineState, seat: number, change: SeatChange["change"]): EngineState => seatsChanged(s, [{ seat, change }]);

function reveal(s: EngineState, cfg: EngineConfig, now: number): EngineState {
  const q = cfg.questions[s.round];
  const result = scoreRound(s.guesses, q.value, q.exactWithin, cfg.scoring, q.precision);
  const missed = s.missed.map((m, seat) => (s.guesses[seat] === null ? m + 1 : 0));
  return { ...s, phase: "reveal", deadline: now + opt(cfg).revealMs, results: [...s.results, result], missed };
}

function openRound(s: EngineState, cfg: EngineConfig, round: number, now: number): EngineState {
  return { ...s, phase: "guess", round, deadline: now + opt(cfg).roundMs, guesses: Array(s.status.length).fill(null) };
}

/**
 * Moves time forward: intro → first question; a question closes at its deadline or as soon as every eligible seat has
 * answered (never early when no seat is eligible); a reveal ends into the next question or the result. An overdue
 * deadline (> OUTAGE_MS late) is treated as an outage: the open question gets a fresh window and nobody is charged.
 */
export function tick(s: EngineState, cfg: EngineConfig, now: number): EngineState {
  const o = opt(cfg);
  if (s.phase === "intro") return now >= s.deadline ? openRound(s, cfg, 0, now) : s;
  if (s.phase === "guess") {
    if (now - s.deadline > OUTAGE_MS) return { ...s, deadline: now + o.roundMs };
    const eligible = eligibleSeats(s);
    const allIn = eligible.length > 0 && eligible.every((seat) => s.guesses[seat] !== null);
    return now >= s.deadline || allIn ? reveal(s, cfg, now) : s;
  }
  if (s.phase === "reveal" && now >= s.deadline) {
    return s.round + 1 >= o.rounds ? { ...s, phase: "over" } : openRound(s, cfg, s.round + 1, now);
  }
  return s;
}

/** The final order (withdrawn seats below every seat that stayed). */
export const finalStandings = (s: EngineState): Standing[] => standings(s.status.length, s.results, withdrawn(s));
