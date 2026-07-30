/**
 * Shared types for the one-time persistent-bot burn-in engine (PR6).
 *
 * The engine gives each persistent roster bot a plausible recent ranked history,
 * backdated over the season window and capped below the live human top-10.
 */
import type { SkillBand } from './s2-distribution.js';

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
  skillBand?: SkillBand;
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
  projectionChecked?: boolean;
}

export interface FixtureScore {
  goals: number;
  penaltyGoals: number;
  totalPoints: number;
  correctAnswers: number;
}

/** Aggregated dry-run report figures. */
export interface DistributionReport {
  botCount: number;
  fixtureCount: number;
  matchesPerBot: { min: number; median: number; max: number; mean: number };
  ladders: Array<{
    name: 'UNCAPPED' | 'CAPPED' | 'FINAL';
    ceilingRp: number;
    tierHistogram: Array<{ tier: string; bots: number; s2Humans: number }>;
    quantiles: Record<'p5' | 'p20' | 'p50' | 'p80' | 'p95' | 'p99' | 'max', number>;
    bands: Array<{ band: SkillBand; min: number; median: number; max: number }>;
  }>;
  ceilingRp: number;
  humanTop10Rp: number | null;
  maxBotRp: number;
  /** Fixed-point seed solver: iterations run and the worst |final - target| RP. */
  seedSolver: { iterations: number; maxResidual: number; converged: boolean };
  ceilingRespected: boolean;
  sampleTimelines: Array<{
    nickname: string;
    baseSkill: number;
    seedRp: number;
    finalRp: number;
    tier: string;
    fixtures: number;
    wins: number;
    losses: number;
  }>;
}
