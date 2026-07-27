/**
 * Shared types for the one-time persistent-bot burn-in engine (PR6).
 *
 * The engine gives each persistent roster bot a plausible season-to-date:
 * 3 placement fixtures + ranked bot-vs-bot fixtures, backdated from the season
 * start to the run date, honoring each bot's schedule/caps/sessions, scored
 * through the REAL Season-2026 RP formula, capped below the live human top-10.
 */

import type { BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';

/** A roster bot as the engine needs it (users + ranked_profiles + synthetic). */
export interface BurnInBot {
  userId: string;
  nickname: string;
  /** Hidden ability on the calibration (theta) scale. Drives win probability. */
  baseSkill: number;
  dailyCap: number;
  /** Activity archetype: preferred hours + session shape (Asia/Tbilisi). */
  schedule: BotSchedule;
  status: 'active' | 'resting' | 'retired';
  /** Live ranked profile at run start (mutated in-memory during simulation). */
  rp: number;
  placementPlayed: number;
  placementWins: number;
  placementStatus: 'unplaced' | 'in_progress' | 'placed';
  currentWinStreak: number;
}

/**
 * Activity archetype parsed from synthetic_player_profiles.schedule jsonb.
 * Deliberately tolerant: missing fields fall back to a broad daytime window so
 * a sparse fixture row still schedules.
 */
export interface BotSchedule {
  /** Hours (0-23, Tbilisi) the bot is active. Empty → the full 07:00-01:23 window. */
  activeHours: number[];
  /** Max fixtures in a single session burst before a rest gap. */
  sessionMax: number;
  /** Minutes between fixtures within a session. */
  intraSessionGapMin: number;
}

/** One scheduled, not-yet-written fixture. */
export interface PlannedFixture {
  /** Stable per-run idempotency key (seed + ordinal); also the receipt key. */
  key: string;
  botAUserId: string;
  botBUserId: string;
  /** Backdated match start (UTC Date). */
  startedAt: Date;
  /** Backdated match end (UTC Date), a few minutes after startedAt. */
  endedAt: Date;
  /** Winner user id, chosen by hidden-skill gap through the real formula. */
  winnerUserId: string;
  /** Winner-decision method persisted into state_payload.winnerDecisionMethod. */
  decision: 'goals' | 'penalty_goals';
  /** Whether either side treats this as a placement fixture at write time. */
  isPlacementContext: boolean;
  /** Plausible per-seat scoreline consistent with the winner + skill gap. */
  scoreA: FixtureScore;
  scoreB: FixtureScore;
  categoryAId: string;
  categoryBId: string;
}

export interface FixtureScore {
  goals: number;
  penaltyGoals: number;
  totalPoints: number;
  correctAnswers: number;
}

/** A pre-run snapshot of one bot's mutable profile state, for rollback. */
export interface ProfileSnapshotRow {
  userId: string;
  rp: number;
  tier: string;
  placementStatus: string;
  placementPlayed: number;
  placementWins: number;
  placementSeedRp: number | null;
  placementPerfSum: number;
  placementPointsForSum: number;
  placementPointsAgainstSum: number;
  currentWinStreak: number;
  lastRankedMatchAt: string | null;
  /** users.total_xp before the run (XP is additive; rollback restores it). */
  totalXp: number;
  /** Present only if a ranked_profiles row already existed pre-run. */
  profileExisted: boolean;
}

export interface BurnInSnapshot {
  createdAt: string;
  seed: number;
  env: string;
  ceilingRp: number;
  humanTop10Rp: number | null;
  marginRp: number;
  profiles: ProfileSnapshotRow[];
}

/** Creation receipt: the match ids written, for a schema-free rollback. */
export interface BurnInReceipt {
  createdAt: string;
  seed: number;
  env: string;
  /** All roster bot user ids — rollback verifies matches touch ONLY these. */
  rosterUserIds: string[];
  matchIds: string[];
  fixtureKeys: string[];
}

export interface BurnInConfig {
  seed: number;
  params: BotModelParams;
  seasonStart: Date;
  runDate: Date;
  /** Population median target fixtures/bot (scaled per-bot by feasibility). */
  targetMatches: number;
  /** Hard-ceiling margin below the human #10 RP. */
  ceilingMarginRp: number;
  execute: boolean;
  snapshotOut: string | null;
  receiptOut: string | null;
  /** Cap the roster for a small dry-run (e.g. a 20-bot fixture preview). */
  limit: number | null;
}

/** Aggregated dry-run report figures. */
export interface DistributionReport {
  botCount: number;
  fixtureCount: number;
  matchesPerBot: { min: number; median: number; max: number; mean: number };
  bandTargets: Record<string, number>;
  bandActual: Record<string, number>;
  ceilingRp: number;
  humanTop10Rp: number | null;
  maxBotRp: number;
  ceilingRespected: boolean;
  sampleTimelines: Array<{
    nickname: string;
    baseSkill: number;
    finalRp: number;
    tier: string;
    fixtures: number;
    wins: number;
    losses: number;
  }>;
}

/** Ladder band definitions (share of roster) — §1.2 hidden-ability 20/30/30/15/5. */
export const BAND_TARGETS: ReadonlyArray<{ name: string; share: number; minRp: number }> = [
  { name: 'elite', share: 0.05, minRp: 3000 },
  { name: 'high', share: 0.15, minRp: 1500 },
  { name: 'mid', share: 0.3, minRp: 800 },
  { name: 'low', share: 0.3, minRp: 400 },
  { name: 'entry', share: 0.2, minRp: 0 },
];
