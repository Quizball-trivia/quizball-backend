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
  /**
   * Canonical content digest (hex) = hash(manifestHash + participants +
   * timestamps + winner + decision + scores). Populated by the scheduler after
   * the manifest hash is known. Uniquely identifies the fixture within a run.
   */
  key: string;
  /** Deterministic match UUID derived from `key`. */
  matchId: string;
  /** Monotonic plan position (for the JSONL receipt / diagnostics only). */
  ordinal: number;
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
  /**
   * Projected post-settlement RP for each seat (the exact value the real
   * formula will produce, computed in-memory by the scheduler). The writer
   * asserts these against the ceiling PRE-COMMIT so a violation never lands.
   */
  projectedRpA: number;
  projectedRpB: number;
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
  /** ranked_profiles.updated_at pre-run — used to detect post-snapshot writes. */
  profileUpdatedAt: string | null;
  /** users.total_xp before the run (XP is additive; rollback restores it). */
  totalXp: number;
  /** Present only if a ranked_profiles row already existed pre-run. */
  profileExisted: boolean;
  /** user_mode_match_stats(mode='ranked') pre-run — captured for full restore. */
  rankedStats: {
    existed: boolean;
    gamesPlayed: number;
    wins: number;
    losses: number;
    draws: number;
    lastMatchAt: string | null;
  };
  /** user_achievements pre-run — captured for full restore (finding 10). */
  achievements: Array<{
    achievementId: string;
    progress: number;
    unlockedAt: string | null;
    sourceMatchId: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface BurnInSnapshot {
  createdAt: string;
  /** The run this snapshot belongs to — mutual-consistency check on rollback. */
  manifestHash: string;
  seed: number;
  env: string;
  ceilingRp: number;
  humanTop10Rp: number | null;
  marginRp: number;
  profiles: ProfileSnapshotRow[];
  /** SHA-256 over the snapshot body (all fields except this one). */
  integrityHash?: string;
}

/**
 * The receipt is now an append-only JSONL file: a single HEADER line followed
 * by one PLANNED line per fixture written durably BEFORE its DB writes, then a
 * matching WRITTEN line after. On resume the header identifies the run and the
 * PLANNED lines enumerate every fixture that may have touched the DB (zero
 * unrecorded fixtures possible).
 */
export type ReceiptLine = ReceiptHeaderLine | ReceiptFixtureLine;

export interface ReceiptHeaderLine {
  kind: 'header';
  createdAt: string;
  manifestHash: string;
  seed: number;
  env: string;
  /** All roster bot user ids — rollback verifies matches touch ONLY these. */
  rosterUserIds: string[];
}

export interface ReceiptFixtureLine {
  kind: 'planned' | 'written';
  ordinal: number;
  key: string;
  matchId: string;
  botAUserId: string;
  botBUserId: string;
  winnerUserId: string;
  startedAt: string;
  endedAt: string;
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
