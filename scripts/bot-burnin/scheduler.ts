/**
 * Deterministic fixture scheduler + pairing for the burn-in engine.
 *
 * Builds the entire season-to-date fixture plan from a seed BEFORE any write:
 *   - Every bot starts placed at its deterministic Season-2 target seed.
 *   - Pairing: RP-neighbor preference with ±150 widening; one match per bot per
 *     timestamp; no repeat within a bot's last 5 opponents; both bots must be
 *     schedule/cap/session-eligible at the fixture time.
 *   - Per-bot depth = min(target, daysSinceReset × dailyCap, session-feasible).
 *   - HARD CEILING: no bot may end above (humanTop10Rp − margin). Enforced by
 *     forcing the win assignment (a capped bot at/over the ceiling is made to
 *     lose against an equal-or-stronger neighbor) — never by RP fudging.
 *
 * RP is advanced in-memory through the placed ranked-formula branch so the
 * dry-run report's final distribution equals what the writer will settle.
 */
import {
  computeSeasonRpDelta,
} from '../../src/modules/ranked/season-rp-formula.js';
import type { BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import type { BurnInBot, PlannedFixture } from './types.js';
import { makeRng, deriveSeed, type Rng } from './rng.js';
import { simulateFixture, winProbability } from './simulator.js';
import { fixtureContentDigest, fixtureMatchIdFromDigest } from './manifest.js';
import { placementWinsForBand, seedRosterBots, type SeededBot } from './s2-distribution.js';

const PLACEMENT_MATCHES = 3;
const WINDOW_START_HOUR = 7; // 07:00 Tbilisi
// Activity window closes at 01:23 Tbilisi (the plan's boundary). Expressed as
// minutes-since-midnight; a bot may START a fixture only inside the window and
// the fixture must also END by this boundary — no 01:2x-01:5x spillover.
const WINDOW_END_MIN_OF_DAY = 1 * 60 + 23; // 01:23
const RECENT_OPPONENT_MEMORY = 5;
const NEIGHBOR_BAND_START = 150;
const NEIGHBOR_BAND_STEP = 150;
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000; // UTC+4, no DST in Georgia
// Largest possible single-fixture RP gain: +50 regular win, +40 win-by-4+
// margin, +10 for beating a stronger opponent. The ceiling guard reserves this
// much headroom so a win can never cross the ceiling.
export const MAX_WIN_DELTA = 100;
// Longest a burn-in fixture can occupy (matches planFixture's max duration) —
// used to guarantee the fixture ENDS by the 01:23 boundary.
const MAX_FIXTURE_DURATION_MS = 7 * 60 * 1000;

interface MutableBot extends BurnInBot {
  fixturesPlayed: number;
  recentOpponents: string[];
  /** Georgia-day → count, to honor the daily cap across the backfill window. */
  perDayCount: Map<string, number>;
  rngStream: Rng;
  /** Wall-clock cursor (UTC ms) the bot is next free after. */
  nextFreeAtMs: number;
  /** Fixtures played in the CURRENT session burst (reset by a rest gap/day). */
  sessionCount: number;
  /** End of the current session's last fixture (UTC ms), for burst detection. */
  sessionLastEndMs: number;
}

function tbilisiDayKey(utcMs: number): string {
  return new Date(utcMs + TBILISI_OFFSET_MS).toISOString().slice(0, 10);
}

function tbilisiHour(utcMs: number): number {
  return new Date(utcMs + TBILISI_OFFSET_MS).getUTCHours();
}

/** Minutes-since-midnight (Tbilisi) for a UTC ms instant. */
function tbilisiMinOfDay(utcMs: number): number {
  const d = new Date(utcMs + TBILISI_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * Is `utcMs` inside the activity window? The window runs 07:00 → 01:23 (next
 * day). Any time at/after 07:00 OR at/before 01:23 is in-window.
 */
function inWindowMinute(utcMs: number): boolean {
  const m = tbilisiMinOfDay(utcMs);
  return m >= WINDOW_START_HOUR * 60 || m <= WINDOW_END_MIN_OF_DAY;
}

/**
 * A fixture STARTING at `atMs` is admissible only if both the start and the
 * latest-possible end stay within the window (no spillover past 01:23) and the
 * bot's archetype hour matches.
 */
function fixtureFitsWindow(bot: MutableBot, atMs: number): boolean {
  if (!inWindowMinute(atMs)) return false;
  if (!inWindowMinute(atMs + MAX_FIXTURE_DURATION_MS)) return false;
  if (bot.schedule.activeHours.length === 0) return true;
  return bot.schedule.activeHours.includes(tbilisiHour(atMs));
}

// A session burst ends when more than SESSION_REST_GAP_MS elapses with no
// fixture; within a burst a bot plays at most schedule.sessionMax fixtures.
const SESSION_REST_GAP_MS = 90 * 60 * 1000; // 90 min idle → new session

/** True if the bot is mid-burst at `atMs` and has already hit its sessionMax. */
function sessionExhausted(bot: MutableBot, atMs: number): boolean {
  const continuingSession = atMs - bot.sessionLastEndMs <= SESSION_REST_GAP_MS;
  if (!continuingSession) return false; // a new session is starting → allowed
  return bot.sessionCount >= Math.max(1, bot.schedule.sessionMax);
}

/** Record a played fixture into the bot's session-burst counters. */
function noteSessionPlay(bot: MutableBot, atMs: number, endMs: number): void {
  const continuingSession = atMs - bot.sessionLastEndMs <= SESSION_REST_GAP_MS;
  bot.sessionCount = continuingSession ? bot.sessionCount + 1 : 1;
  bot.sessionLastEndMs = endMs;
}

/**
 * Per-bot feasible fixture depth: the population target, bounded by the day
 * budget (daysSinceReset × dailyCap) and by the bot status. Low-cap/resting
 * bots correctly get fewer (§1.3 — "15-40" is a population median, not a
 * per-bot promise).
 */
function feasibleDepth(bot: MutableBot, target: number, daysSinceReset: number): number {
  if (bot.status === 'retired') return 0;
  const dayBudget = Math.max(0, Math.floor(daysSinceReset * bot.dailyCap));
  const statusScale = bot.status === 'resting' ? 0.4 : 1;
  return Math.max(0, Math.min(target, Math.floor(dayBudget * statusScale)));
}

function applyInMemoryOutcome(
  bot: MutableBot,
  isWin: boolean,
  decision: 'goals' | 'penalty_goals',
  goalMargin: number,
  opponentIsStronger: boolean,
): void {
  const delta = computeSeasonRpDelta(isWin, decision, goalMargin, opponentIsStronger);
  bot.rp = Math.max(0, bot.rp + delta);
  bot.currentWinStreak = isWin ? bot.currentWinStreak + 1 : 0;
  if (bot.placementStatus !== 'placed') {
    bot.placementPlayed = Math.min(PLACEMENT_MATCHES, bot.placementPlayed + 1);
    if (isWin) bot.placementWins += 1;
    bot.placementStatus = bot.placementPlayed >= PLACEMENT_MATCHES ? 'placed' : 'in_progress';
  }
}

/**
 * Pick an eligible opponent for `bot` at `atMs`, preferring RP neighbors and
 * widening the band until one is found. Returns null if none is eligible (the
 * caller then advances the bot's clock and retries later).
 */
function pickOpponent(
  bot: MutableBot,
  pool: MutableBot[],
  atMs: number,
  remainingByBot: Map<string, number>,
  ceilingRp: number,
): MutableBot | null {
  const dayKey = tbilisiDayKey(atMs);
  // If the initiator is itself within one max-win of the ceiling, it must be
  // paired with a bot that CAN safely win, so the ceiling is always respected
  // by win assignment (never RP fudging).
  const botUnsafe = bot.rp + MAX_WIN_DELTA > ceilingRp;
  const candidates = pool.filter((other) => {
    if (other.userId === bot.userId) return false;
    if ((remainingByBot.get(other.userId) ?? 0) <= 0) return false;
    if (other.status === 'retired') return false;
    if (other.nextFreeAtMs > atMs) return false; // busy (one match per timestamp)
    if (!fixtureFitsWindow(other, atMs)) return false; // in-window + ends by 01:23
    if ((other.perDayCount.get(dayKey) ?? 0) >= other.dailyCap) return false;
    if (sessionExhausted(other, atMs)) return false; // sessionMax burst honored
    if (bot.recentOpponents.includes(other.userId)) return false;
    // Never pair two bots that are BOTH within a max-win of the ceiling —
    // otherwise no ceiling-respecting winner exists.
    if (botUnsafe && other.rp + MAX_WIN_DELTA > ceilingRp) return false;
    return true;
  });
  if (candidates.length === 0) return null;

  for (let band = NEIGHBOR_BAND_START; band <= 6000; band += NEIGHBOR_BAND_STEP) {
    const near = candidates.filter((c) => Math.abs(c.rp - bot.rp) <= band);
    if (near.length > 0) {
      near.sort((a, b) => Math.abs(a.rp - bot.rp) - Math.abs(b.rp - bot.rp));
      // Small deterministic jitter among the nearest few to avoid a rigid ladder.
      const topK = near.slice(0, Math.min(4, near.length));
      return bot.rngStream.pick(topK);
    }
  }
  return candidates[0];
}

export interface ScheduleResult {
  fixtures: PlannedFixture[];
  /** Final in-memory bot state (RP/placement/streak) for the report. */
  finalBots: BurnInBot[];
  /** The Stage-A seeds this plan was projected from (solver output when overridden). */
  seededBots: SeededBot[];
}

export function buildSchedule(opts: {
  bots: BurnInBot[];
  params: BotModelParams;
  seed: number;
  seasonStart: Date;
  runDate: Date;
  targetMatches: number;
  ceilingRp: number;
  categoryIds: string[];
  /** Run manifest hash — folded into every fixture's canonical content key. */
  manifestHash: string;
  /**
   * Pre-compensated starting RP per bot, from the seed solver. The plan is
   * deterministic, so the solver back-solves the seeds whose Stage-B trajectory
   * LANDS on the S2 target; without it the seeds are the target itself and the
   * net-positive RP formula inflates every bot off-shape.
   */
  seedOverrides?: ReadonlyMap<string, number>;
}): ScheduleResult {
  const { params, seed, seasonStart, runDate, targetMatches, ceilingRp, categoryIds, manifestHash, seedOverrides } = opts;
  const rng = makeRng(seed);
  const daysSinceReset = Math.max(
    1,
    (runDate.getTime() - seasonStart.getTime()) / (24 * 60 * 60 * 1000),
  );

  const seededById = new Map(
    seedRosterBots(opts.bots, seed, ceilingRp).map((seededBot) => [seededBot.userId, seededBot]),
  );

  const bots: MutableBot[] = opts.bots.map((b) => ({
    userId: b.userId,
    nickname: b.nickname,
    baseSkill: b.baseSkill,
    dailyCap: b.dailyCap,
    schedule: b.schedule,
    status: b.status,
    rp: seedOverrides?.get(b.userId) ?? seededById.get(b.userId)!.seededRp,
    placementPlayed: PLACEMENT_MATCHES,
    placementWins: placementWinsForBand(seededById.get(b.userId)!.band),
    placementStatus: 'placed',
    currentWinStreak: 0,
    fixturesPlayed: 0,
    recentOpponents: [],
    perDayCount: new Map(),
    rngStream: makeRng(deriveSeed(seed, b.userId)),
    nextFreeAtMs: seasonStart.getTime(),
    sessionCount: 0,
    sessionLastEndMs: Number.NEGATIVE_INFINITY,
  }));
  const byId = new Map(bots.map((b) => [b.userId, b]));

  const remainingByBot = new Map<string, number>();
  for (const b of bots) remainingByBot.set(b.userId, feasibleDepth(b, targetMatches, daysSinceReset));

  // Total fixtures across the run: half the sum of per-bot depths (each fixture
  // consumes two bots).
  const fixtures: PlannedFixture[] = [];
  let ordinal = 0;

  // CHRONOLOGICAL GREEDY: each round, the initiator is the hungry bot with the
  // globally-EARLIEST admissible slot (tie-break by userId — a stable, seeded-
  // independent total order). This emits fixtures in non-decreasing startedAt
  // order BY CONSTRUCTION, so pairing + ceiling enforcement + the projected RP
  // trajectory happen in exactly the order the writer applies them. That makes
  // the ceiling guarantee airtight at write time and lets the writer assert the
  // settled RP equals the projected RP (no post-hoc sort, no divergence).
  const runEndMs = runDate.getTime();
  let safety = bots.length * targetMatches * 8;
  while (safety-- > 0) {
    const hungry = bots.filter((b) => (remainingByBot.get(b.userId) ?? 0) > 0 && b.status !== 'retired');
    if (hungry.length < 2) break;

    // Each bot's next admissible slot (pure read of its clock/caps/sessions).
    let bot: MutableBot | null = null;
    let atMs = Number.POSITIVE_INFINITY;
    for (const cand of hungry) {
      const slot = advanceToActiveSlot(cand, runEndMs);
      if (slot === null) {
        remainingByBot.set(cand.userId, 0); // no feasible slot left → stop owing it
        continue;
      }
      // Global-min slot; tie-break on userId for a stable, deterministic order.
      if (slot < atMs || (slot === atMs && (bot === null || cand.userId < bot.userId))) {
        bot = cand;
        atMs = slot;
      }
    }
    if (bot === null) continue; // every hungry bot exhausted its window this round

    const opp = pickOpponent(bot, bots, atMs, remainingByBot, ceilingRp);
    if (!opp) {
      // No eligible partner right now — nudge the bot's clock forward and retry.
      bot.nextFreeAtMs = atMs + 37 * 60 * 1000;
      if (bot.nextFreeAtMs >= runDate.getTime()) remainingByBot.set(bot.userId, 0);
      continue;
    }

    const fixture = planFixture({
      a: bot,
      b: opp,
      atMs,
      params,
      rng,
      ceilingRp,
      categoryIds,
      ordinal: ordinal++,
      manifestHash,
    });
    fixtures.push(fixture);

    // Commit in-memory state for both sides.
    commitFixture(fixture, byId);
    const endMs = fixture.endedAt.getTime();
    for (const b of [bot, opp]) {
      b.fixturesPlayed++;
      const dayKey = tbilisiDayKey(atMs);
      b.perDayCount.set(dayKey, (b.perDayCount.get(dayKey) ?? 0) + 1);
      noteSessionPlay(b, atMs, endMs);
      b.recentOpponents = [b === bot ? opp.userId : bot.userId, ...b.recentOpponents].slice(
        0,
        RECENT_OPPONENT_MEMORY,
      );
      remainingByBot.set(b.userId, (remainingByBot.get(b.userId) ?? 0) - 1);
    }
    // Both bots are busy until a short intra-session gap elapses.
    const gapMs = Math.max(8, bot.schedule.intraSessionGapMin) * 60 * 1000;
    bot.nextFreeAtMs = endMs + gapMs;
    opp.nextFreeAtMs = endMs + gapMs;
  }

  // Chronological greedy emits fixtures in non-decreasing startedAt order by
  // construction. Assert the invariant rather than re-sort — a violation would
  // mean pairing/ceiling/projection order diverged from write order (a bug).
  for (let i = 1; i < fixtures.length; i++) {
    if (fixtures[i].startedAt.getTime() < fixtures[i - 1].startedAt.getTime()) {
      throw new Error(`scheduler invariant violated: fixture ${i} startedAt < previous (not chronological)`);
    }
  }

  return {
    fixtures,
    finalBots: bots.map((b) => ({
      userId: b.userId,
      nickname: b.nickname,
      baseSkill: b.baseSkill,
      dailyCap: b.dailyCap,
      schedule: b.schedule,
      status: b.status,
      rp: b.rp,
      placementPlayed: b.placementPlayed,
      placementWins: b.placementWins,
      placementStatus: b.placementStatus,
      currentWinStreak: b.currentWinStreak,
    })),
    seededBots: opts.bots.map((b) => {
      const base = seededById.get(b.userId)!;
      const override = seedOverrides?.get(b.userId);
      return override == null ? base : { ...base, seededRp: override };
    }),
  };
}

/**
 * Move the bot's clock to its next schedule-active, in-window slot (start AND
 * projected end inside 07:00-01:23) that also has daily-cap and session-burst
 * headroom. Returns the UTC ms, or null if no slot exists before the run date.
 */
function advanceToActiveSlot(bot: MutableBot, runEndMs: number): number | null {
  let cursor = bot.nextFreeAtMs;
  let guard = 24 * 4 * 400; // 15-min probes over ~400 days
  const jumpToNextDayStart = () => {
    const next = new Date(cursor + TBILISI_OFFSET_MS);
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(WINDOW_START_HOUR, 0, 0, 0);
    cursor = next.getTime() - TBILISI_OFFSET_MS;
  };
  while (cursor < runEndMs && guard-- > 0) {
    const dayKey = tbilisiDayKey(cursor);
    const capReached = (bot.perDayCount.get(dayKey) ?? 0) >= bot.dailyCap;
    if (capReached) {
      jumpToNextDayStart();
      continue;
    }
    if (fixtureFitsWindow(bot, cursor) && !sessionExhausted(bot, cursor)) {
      return cursor;
    }
    // Session spent mid-burst: jump past the rest gap to start a fresh session.
    if (fixtureFitsWindow(bot, cursor) && sessionExhausted(bot, cursor)) {
      cursor = bot.sessionLastEndMs + SESSION_REST_GAP_MS + 60 * 1000;
      continue;
    }
    // Out of window: probe forward 15 min; if past 01:23, jump to next 07:00.
    if (!inWindowMinute(cursor)) jumpToNextDayStart();
    else cursor += 15 * 60 * 1000;
  }
  return null;
}

function planFixture(opts: {
  a: MutableBot;
  b: MutableBot;
  atMs: number;
  params: BotModelParams;
  rng: Rng;
  ceilingRp: number;
  categoryIds: string[];
  ordinal: number;
  manifestHash: string;
}): PlannedFixture {
  const { a, b, atMs, params, rng, ceilingRp, categoryIds, ordinal, manifestHash } = opts;

  // HARD CEILING (win assignment only — never RP fudging): a side may win only
  // if its projected post-win RP stays at/under the ceiling. MAX_WIN_DELTA is
  // the largest possible single-fixture win (+50 base +40 margin +10 upset).
  // A side "can safely win" iff rp + MAX_WIN_DELTA ≤ ceiling. pickOpponent
  // guarantees the two bots are never BOTH unsafe, so at least one side can
  // always take a ceiling-respecting win.
  const aCanSafelyWin = a.rp + MAX_WIN_DELTA <= ceilingRp;
  const bCanSafelyWin = b.rp + MAX_WIN_DELTA <= ceilingRp;
  let forceWinnerIsA: boolean | undefined;
  if (!aCanSafelyWin && bCanSafelyWin) forceWinnerIsA = false;
  else if (!bCanSafelyWin && aCanSafelyWin) forceWinnerIsA = true;
  else if (!aCanSafelyWin && !bCanSafelyWin) {
    // Defensive: pickOpponent should preclude this. Force the lower-RP side to
    // win (furthest from the ceiling); both being unsafe is a scheduling bug.
    forceWinnerIsA = a.rp <= b.rp;
  } else {
    forceWinnerIsA = rng.bernoulli(winProbability(a.baseSkill, b.baseSkill, params));
  }

  const sim = simulateFixture(a.baseSkill, b.baseSkill, params, rng, forceWinnerIsA);

  const durationMs = rng.int(3, 7) * 60 * 1000; // ≤ MAX_FIXTURE_DURATION_MS
  const startedAt = new Date(atMs);
  const endedAt = new Date(atMs + durationMs);
  const winnerUserId = sim.winnerIsA ? a.userId : b.userId;
  const isPlacementContext = false;
  const categoryAId = rng.pick(categoryIds);
  const categoryBId = rng.pick(categoryIds);

  // Canonical fixture key = hash(manifest + participants + timestamps + winner
  // + decision + scores). The deterministic matchId derives from it. A changed
  // roster/config/runDate yields a different manifest hash → different key, so
  // a UUID can never silently represent a different fixture (finding 4).
  const key = fixtureContentDigest(manifestHash, {
    botAUserId: a.userId,
    botBUserId: b.userId,
    startedAt,
    endedAt,
    winnerUserId,
    decision: sim.decision,
    scoreA: sim.scoreA,
    scoreB: sim.scoreB,
  });

  return {
    key,
    matchId: fixtureMatchIdFromDigest(key),
    ordinal,
    botAUserId: a.userId,
    botBUserId: b.userId,
    startedAt,
    endedAt,
    winnerUserId,
    decision: sim.decision,
    isPlacementContext,
    scoreA: sim.scoreA,
    scoreB: sim.scoreB,
    categoryAId,
    categoryBId,
    // Overwritten by commitFixture with the true projected post-settlement RP.
    projectedRpA: 0,
    projectedRpB: 0,
    projectionChecked: true,
  };
}

function commitFixture(fixture: PlannedFixture, byId: Map<string, MutableBot>): void {
  const a = byId.get(fixture.botAUserId)!;
  const b = byId.get(fixture.botBUserId)!;
  const aWon = fixture.winnerUserId === a.userId;
  const goalMarginA = fixture.scoreA.goals - fixture.scoreB.goals;
  const aStronger = a.rp > b.rp;
  applyInMemoryOutcome(a, aWon, fixture.decision, goalMarginA, b.rp > a.rp);
  applyInMemoryOutcome(b, !aWon, fixture.decision, -goalMarginA, aStronger);
  // Record the exact projected post-settlement RP the real formula will produce
  // (same computeSeasonRpDelta), so the writer can assert PRE-COMMIT that no
  // fixture pushes a bot over the ceiling (finding 6).
  fixture.projectedRpA = a.rp;
  fixture.projectedRpB = b.rp;
}
