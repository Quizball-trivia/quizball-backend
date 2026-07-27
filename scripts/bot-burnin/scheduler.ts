/**
 * Deterministic fixture scheduler + pairing for the burn-in engine.
 *
 * Builds the entire season-to-date fixture plan from a seed BEFORE any write:
 *   - Placement first: each bot's first 3 fixtures carry placement semantics.
 *   - Pairing: RP-neighbor preference with ±150 widening; one match per bot per
 *     timestamp; no repeat within a bot's last 5 opponents; both bots must be
 *     schedule/cap/session-eligible at the fixture time.
 *   - Per-bot depth = min(target, daysSinceReset × dailyCap, session-feasible).
 *   - HARD CEILING: no bot may end above (humanTop10Rp − margin). Enforced by
 *     forcing the win assignment (a capped bot at/over the ceiling is made to
 *     lose against an equal-or-stronger neighbor) — never by RP fudging.
 *
 * RP is advanced in-memory through the REAL formula (computeSeasonRpDelta + the
 * placement running-rank semantics copied from ranked.service) so the dry-run
 * report's final distribution equals what the writer will settle. The writer
 * re-derives nothing about RP; it drives the real settlement path per fixture.
 */
import {
  computeSeasonRpDelta,
  SEASON_INITIAL_RP,
} from '../../src/modules/ranked/season-rp-formula.js';
import type { BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import type { BurnInBot, PlannedFixture } from './types.js';
import { makeRng, deriveSeed, type Rng } from './rng.js';
import { simulateFixture, winProbability } from './simulator.js';

const PLACEMENT_MATCHES = 3;
const WINDOW_START_HOUR = 7; // 07:00 Tbilisi
const WINDOW_END_HOUR = 25; // 01:23 next day ≈ hour 25 in a 07:00-anchored day
const RECENT_OPPONENT_MEMORY = 5;
const NEIGHBOR_BAND_START = 150;
const NEIGHBOR_BAND_STEP = 150;
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000; // UTC+4, no DST in Georgia
// Largest possible single-fixture RP gain: +50 regular win, +40 win-by-4+
// margin, +10 for beating a stronger opponent. The ceiling guard reserves this
// much headroom so a win can never cross the ceiling.
const MAX_WIN_DELTA = 100;

interface MutableBot extends BurnInBot {
  fixturesPlayed: number;
  recentOpponents: string[];
  /** Georgia-day → count, to honor the daily cap across the backfill window. */
  perDayCount: Map<string, number>;
  rngStream: Rng;
  /** Wall-clock cursor (UTC ms) the bot is next free after. */
  nextFreeAtMs: number;
}

function tbilisiDayKey(utcMs: number): string {
  return new Date(utcMs + TBILISI_OFFSET_MS).toISOString().slice(0, 10);
}

function tbilisiHour(utcMs: number): number {
  return new Date(utcMs + TBILISI_OFFSET_MS).getUTCHours();
}

/** Is `hour` inside the bot's active archetype (or the default full window)? */
function hourActive(bot: MutableBot, hour: number): boolean {
  const normalized = hour < WINDOW_START_HOUR ? hour + 24 : hour; // 0-1am → 24-25
  if (normalized < WINDOW_START_HOUR || normalized > WINDOW_END_HOUR) return false;
  if (bot.schedule.activeHours.length === 0) return true;
  return bot.schedule.activeHours.includes(hour);
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
    if (!hourActive(other, tbilisiHour(atMs))) return false;
    if ((other.perDayCount.get(dayKey) ?? 0) >= other.dailyCap) return false;
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
}): ScheduleResult {
  const { params, seed, seasonStart, runDate, targetMatches, ceilingRp, categoryIds } = opts;
  const rng = makeRng(seed);
  const daysSinceReset = Math.max(
    1,
    (runDate.getTime() - seasonStart.getTime()) / (24 * 60 * 60 * 1000),
  );

  const bots: MutableBot[] = opts.bots.map((b) => ({
    ...b,
    rp: SEASON_INITIAL_RP,
    placementPlayed: 0,
    placementWins: 0,
    placementStatus: 'unplaced',
    currentWinStreak: 0,
    fixturesPlayed: 0,
    recentOpponents: [],
    perDayCount: new Map(),
    rngStream: makeRng(deriveSeed(seed, b.userId)),
    nextFreeAtMs: seasonStart.getTime(),
  }));
  const byId = new Map(bots.map((b) => [b.userId, b]));

  const remainingByBot = new Map<string, number>();
  for (const b of bots) remainingByBot.set(b.userId, feasibleDepth(b, targetMatches, daysSinceReset));

  // Total fixtures across the run: half the sum of per-bot depths (each fixture
  // consumes two bots). Iterate in RP order so placement/low bots get matched
  // early and the ladder spreads before neighbors climb away.
  const fixtures: PlannedFixture[] = [];
  const windowMs = runDate.getTime() - seasonStart.getTime();
  let ordinal = 0;

  // Round-robin over "hungry" bots (still owed fixtures), each round advancing
  // the initiator's clock into a plausible active slot and pairing it.
  let safety = bots.length * targetMatches * 8;
  while (safety-- > 0) {
    const hungry = bots.filter((b) => (remainingByBot.get(b.userId) ?? 0) > 0 && b.status !== 'retired');
    if (hungry.length < 2) break;
    // Initiator = the hungriest, RP-ascending tiebreak (spreads the low end).
    hungry.sort((a, b) => {
      const rem = (remainingByBot.get(b.userId) ?? 0) - (remainingByBot.get(a.userId) ?? 0);
      return rem !== 0 ? rem : a.rp - b.rp;
    });
    const bot = hungry[0];

    // Advance the initiator's clock to its next active, in-window, in-window-cap
    // slot (session-aware: jump to the next day if the session/cap is spent).
    const atMs = advanceToActiveSlot(bot, runDate.getTime());
    if (atMs === null) {
      remainingByBot.set(bot.userId, 0); // no feasible slot left → stop owing it
      continue;
    }

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
      seed,
      windowMs,
      seasonStartMs: seasonStart.getTime(),
    });
    fixtures.push(fixture);

    // Commit in-memory state for both sides.
    commitFixture(fixture, byId);
    for (const b of [bot, opp]) {
      b.fixturesPlayed++;
      const dayKey = tbilisiDayKey(atMs);
      b.perDayCount.set(dayKey, (b.perDayCount.get(dayKey) ?? 0) + 1);
      b.recentOpponents = [b === bot ? opp.userId : bot.userId, ...b.recentOpponents].slice(
        0,
        RECENT_OPPONENT_MEMORY,
      );
      remainingByBot.set(b.userId, (remainingByBot.get(b.userId) ?? 0) - 1);
    }
    // Both bots are busy until a short intra-session gap elapses.
    const gapMs = Math.max(8, bot.schedule.intraSessionGapMin) * 60 * 1000;
    bot.nextFreeAtMs = atMs + gapMs;
    opp.nextFreeAtMs = atMs + gapMs;
  }

  fixtures.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

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
  };
}

/**
 * Move the bot's clock to its next schedule-active, in-window slot that also has
 * daily-cap headroom. Returns the UTC ms, or null if no slot exists before the
 * run date. Session bursts are honored implicitly by nextFreeAtMs (set to a
 * short gap after each fixture) plus the daily cap.
 */
function advanceToActiveSlot(bot: MutableBot, runEndMs: number): number | null {
  let cursor = bot.nextFreeAtMs;
  let guard = 24 * 400; // up to ~400 days of hourly probes
  while (cursor < runEndMs && guard-- > 0) {
    const hour = tbilisiHour(cursor);
    const dayKey = tbilisiDayKey(cursor);
    const capReached = (bot.perDayCount.get(dayKey) ?? 0) >= bot.dailyCap;
    if (!capReached && hourActive(bot, hour)) {
      return cursor;
    }
    // Jump forward: to next hour if just inactive, to next day 07:00 if cap-spent.
    if (capReached) {
      const next = new Date(cursor + TBILISI_OFFSET_MS);
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(WINDOW_START_HOUR, 0, 0, 0);
      cursor = next.getTime() - TBILISI_OFFSET_MS;
    } else {
      cursor += 60 * 60 * 1000;
    }
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
  seed: number;
  windowMs: number;
  seasonStartMs: number;
}): PlannedFixture {
  const { a, b, atMs, params, rng, ceilingRp, categoryIds, ordinal, seed } = opts;

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

  const durationMs = rng.int(3, 7) * 60 * 1000;
  const startedAt = new Date(atMs);
  const endedAt = new Date(atMs + durationMs);
  const winnerUserId = sim.winnerIsA ? a.userId : b.userId;
  const isPlacementContext = a.placementStatus !== 'placed' || b.placementStatus !== 'placed';

  return {
    key: `burnin:${seed}:${ordinal}`,
    botAUserId: a.userId,
    botBUserId: b.userId,
    startedAt,
    endedAt,
    winnerUserId,
    decision: sim.decision,
    isPlacementContext,
    scoreA: sim.scoreA,
    scoreB: sim.scoreB,
    categoryAId: rng.pick(categoryIds),
    categoryBId: rng.pick(categoryIds),
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
}
