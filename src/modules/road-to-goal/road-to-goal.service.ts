import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { sql, type TransactionSql } from '../../db/index.js';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { I18nField } from '../../db/types.js';
import { storeRepo } from '../store/store.repo.js';
import {
  ROAD_TO_GOAL_ACCURACY_PRIORS_BP,
  ROAD_TO_GOAL_CANDIDATES_PER_DIFFICULTY,
  ROAD_TO_GOAL_COMMITMENT_MS,
  ROAD_TO_GOAL_COMMITMENT_VERSION,
  ROAD_TO_GOAL_DECISION_MS,
  ROAD_TO_GOAL_FALLBACK_CANDIDATES_PER_DIFFICULTY,
  ROAD_TO_GOAL_MAX_CANDIDATE_PAGES,
  ROAD_TO_GOAL_NETWORK_GRACE_MS,
  ROAD_TO_GOAL_PAYOUT_EVENT,
  ROAD_TO_GOAL_QUESTION_MS,
  ROAD_TO_GOAL_SERVER_WINDOW_MS,
  ROAD_TO_GOAL_STAKE_EVENT,
  ROAD_TO_GOAL_ZONES,
  isRoadToGoalStake,
  roadToGoalPayoutIdempotencyKey,
  roadToGoalStakeIdempotencyKey,
} from './road-to-goal.constants.js';
import {
  applyQuestionCalibrations,
  assertCalibrationVersion,
  ensureRoadToGoalDailyCalibration,
  publishRoadToGoalDailyCalibration,
} from './road-to-goal.calibration.js';
import {
  calculateRoadToGoalSurvivalOdds,
  newRoadToGoalServerSeed,
  ROAD_TO_GOAL_RULES_MANIFEST,
  roadToGoalDidSurvive,
  roadToGoalQuestionHashes,
  roadToGoalQuestionSetHash,
  roadToGoalRulesManifestByHash,
  roadToGoalRulesManifestHash,
  roadToGoalServerSeedCommitment,
  roadToGoalZoneRollBp,
  type RoadToGoalRulesManifest,
} from './road-to-goal.fairness.js';
import { buildRoadToGoalQuestionSet } from './road-to-goal.questions.js';
import { roadToGoalRepo } from './road-to-goal.repo.js';
import {
  trackRoadToGoalQuestionResolved,
  trackRoadToGoalRunSettled,
  trackRoadToGoalRunStarted,
} from './road-to-goal.analytics.js';
import type {
  RoadToGoalDifficulty,
  RoadToGoalCommitmentRow,
  RoadToGoalEventRow,
  RoadToGoalPhase,
  RoadToGoalQuestionCandidate,
  RoadToGoalQuestionImage,
  RoadToGoalQuestionSnapshot,
  RoadToGoalRoundRow,
  RoadToGoalStatus,
} from './road-to-goal.types.js';

export interface RoadToGoalPublicState {
  round_id: string;
  status: RoadToGoalStatus;
  phase: RoadToGoalPhase;
  state_version: number;
  stake_coins: number;
  cleared_zones: number;
  total_zones: number;
  current_multiplier_bp: number;
  next_multiplier_bp: number | null;
  current_return_coins: number;
  next_return_coins: number | null;
  zone_multipliers_bp: readonly number[];
  calibration_version_id: string | null;
  commitment_version: 3 | null;
  commit_hash: string | null;
  rules_manifest_hash: string | null;
  question_set_hash: string | null;
  client_seed: string | null;
  server_seed: string | null;
  auto_cashout_zone: number | null;
  decision_deadline_at: string | null;
  settlement_reason: string | null;
  question: {
    question_id: string;
    zone: number;
    difficulty: RoadToGoalDifficulty;
    prompt: I18nField;
    image: RoadToGoalQuestionImage | null;
    options: Array<{ id: string; text: I18nField }>;
    duration_ms: number;
    deadline_at: string;
    expected_accuracy_bp: number;
    target_survival_bp: number;
    correct_survival_bp: number;
    wrong_survival_bp: number;
  } | null;
  payout_coins: number | null;
  server_now: string;
}

export interface RoadToGoalPreparedCommitment {
  commitment_id: string;
  commitment_version: 3;
  calibration_version_id: string;
  stake_coins: number;
  auto_cashout_zone: number | null;
  commit_hash: string;
  rules_manifest: typeof ROAD_TO_GOAL_RULES_MANIFEST;
  rules_manifest_hash: string;
  question_set_hash: string;
  question_hashes: string[];
  expires_at: string;
  server_now: string;
}

export interface RoadToGoalAnswerResult {
  outcome: 'correct' | 'wrong' | 'late';
  correct_option_id: string;
  survived: boolean;
  expected_accuracy_bp: number;
  target_survival_bp: number;
  correct_survival_bp: number;
  wrong_survival_bp: number;
  applied_survival_bp: number;
  roll_bp: number;
  state: RoadToGoalPublicState;
}

export interface RoadToGoalProof {
  version: 3;
  round_id: string;
  calibration_version_id: string | null;
  commitment_version: 3;
  commit_hash: string;
  rules_manifest: typeof ROAD_TO_GOAL_RULES_MANIFEST;
  rules_manifest_hash: string;
  question_set_hash: string;
  question_hashes: string[];
  stake_coins: number;
  auto_cashout_zone: number | null;
  question_set: Array<{
    zone: number;
    commitment_salt: string;
    question_id: string;
    difficulty: RoadToGoalDifficulty;
    prompt: I18nField;
    image: RoadToGoalQuestionImage | null;
    options: Array<{ id: string; text: I18nField }>;
    correct_option_id: string;
    expected_accuracy_bp: number;
    calibration_source: RoadToGoalQuestionSnapshot['calibration_source'];
  }>;
  server_seed: string;
  client_seed: string;
  status: Exclude<RoadToGoalStatus, 'active'>;
  payout_coins: number;
  cleared_zones: number;
  zones: Array<{
    zone: number;
    question_id: string;
    answer_option_id: string | null;
    correct_option_id: string;
    outcome: 'correct' | 'wrong' | 'late';
    expected_accuracy_bp: number;
    target_survival_bp: number;
    correct_survival_bp: number;
    wrong_survival_bp: number;
    applied_survival_bp: number;
    roll_bp: number;
    survived: boolean;
  }>;
}

interface PostgresErrorShape {
  code?: string;
  constraint_name?: string;
  constraint?: string;
}

interface AttemptResolution {
  row: RoadToGoalRoundRow;
  result: Omit<RoadToGoalAnswerResult, 'state'>;
}

type DeferredAnalytics = Array<() => void>;
const ROAD_TO_GOAL_SWEEP_BUDGET_MS = 5_000;
const ROAD_TO_GOAL_MAX_SWEEP_ATTEMPTS = 1_000;

/** PostHog is intentionally outside the database transaction. A failed commit
 * must never produce an authoritative gameplay or economy event. */
async function withRoadToGoalAnalytics<T>(
  callback: (tx: TransactionSql, analytics: DeferredAnalytics) => Promise<T>
): Promise<T> {
  const analytics: DeferredAnalytics = [];
  const result = await sql.begin(async (tx) => callback(tx, analytics)) as T;
  for (const emit of analytics) emit();
  return result;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decimal(value: number | string | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError('Invalid decimal value in Road to Goal state', 500);
  }
  return parsed;
}

function databaseNow(row: { database_now?: string }): string {
  return row.database_now ?? new Date().toISOString();
}

function databaseDeadlineAfter(row: { database_now?: string }, delayMs: number): string {
  return new Date(new Date(databaseNow(row)).getTime() + delayMs).toISOString();
}

function toPreparedCommitment(row: RoadToGoalCommitmentRow): RoadToGoalPreparedCommitment {
  assertSupportedCommitment(row);
  const questions = readCommittedQuestionSet(row);
  return {
    commitment_id: row.round_id,
    commitment_version: row.commitment_version,
    calibration_version_id: row.calibration_version_id,
    stake_coins: row.stake_coins,
    auto_cashout_zone: row.auto_cashout_zone,
    commit_hash: row.commit_hash,
    rules_manifest: row.rules_manifest as unknown as typeof ROAD_TO_GOAL_RULES_MANIFEST,
    rules_manifest_hash: row.rules_manifest_hash,
    question_set_hash: row.question_set_hash,
    question_hashes: roadToGoalQuestionHashes(questions),
    expires_at: row.expires_at,
    server_now: databaseNow(row),
  };
}

function readQuestionSnapshotJson(value: unknown): RoadToGoalQuestionSnapshot[] {
  const parsed = typeof value === 'string' ? safeJson(value) : value;
  if (!Array.isArray(parsed) || parsed.length !== ROAD_TO_GOAL_ZONES) {
    throw new AppError('Road to Goal question snapshot is invalid', 500);
  }
  return parsed as unknown as RoadToGoalQuestionSnapshot[];
}

function readQuestionSet(row: RoadToGoalRoundRow): RoadToGoalQuestionSnapshot[] {
  const questions = readQuestionSnapshotJson(row.run_questions);
  if (
    row.commitment_version === ROAD_TO_GOAL_COMMITMENT_VERSION
    && row.question_set_hash !== roadToGoalQuestionSetHash(questions)
  ) {
    throw new AppError('Road to Goal round question commitment is invalid', 500);
  }
  return questions;
}

function readCommittedQuestionSet(row: RoadToGoalCommitmentRow): RoadToGoalQuestionSnapshot[] {
  return readQuestionSnapshotJson(row.run_questions);
}

function currentQuestion(row: RoadToGoalRoundRow): RoadToGoalQuestionSnapshot {
  const question = readQuestionSet(row)[row.cleared_zones];
  if (!question) throw new AppError('Road to Goal question snapshot is incomplete', 500);
  return question;
}

function expectedAccuracyForQuestion(question: RoadToGoalQuestionSnapshot): number {
  return Number.isSafeInteger(question.expected_accuracy_bp)
    ? question.expected_accuracy_bp
    : ROAD_TO_GOAL_ACCURACY_PRIORS_BP[question.difficulty];
}

function rulesForHash(hash: string | null): RoadToGoalRulesManifest {
  const rules = hash ? roadToGoalRulesManifestByHash(hash) : null;
  if (!rules) throw new AppError('Road to Goal ruleset is unsupported', 500);
  return rules;
}

function multiplierForClearedZones(
  rules: RoadToGoalRulesManifest,
  clearedZones: number
): number {
  if (clearedZones === 0) return 10_000;
  const multiplier = rules.multiplierLadderBp[clearedZones - 1];
  if (multiplier == null) throw new RangeError(`Invalid cleared-zone count: ${clearedZones}`);
  return multiplier;
}

function payoutMinorForRules(
  rules: RoadToGoalRulesManifest,
  stakeCoins: number,
  clearedZones: number
): number {
  const payoutMinor = (
    BigInt(stakeCoins) * 100n * BigInt(multiplierForClearedZones(rules, clearedZones))
  ) / 10_000n;
  const payout = Number(payoutMinor);
  if (!Number.isSafeInteger(payout)) throw new RangeError('Road to Goal payout exceeds safe range');
  return payout;
}

function payoutForRules(
  rules: RoadToGoalRulesManifest,
  stakeCoins: number,
  clearedZones: number
): number {
  return payoutMinorForRules(rules, stakeCoins, clearedZones) / 100;
}

function oddsForQuestion(
  question: RoadToGoalQuestionSnapshot,
  zoneIndex: number,
  rules: RoadToGoalRulesManifest
) {
  return calculateRoadToGoalSurvivalOdds({
    multiplierLadderBp: rules.multiplierLadderBp,
    zoneIndex,
    expectedAccuracyBp: expectedAccuracyForQuestion(question),
    rules,
  });
}

function toPublicState(row: RoadToGoalRoundRow): RoadToGoalPublicState {
  const rules = rulesForHash(row.rules_manifest_hash);
  const active = row.status === 'active';
  const question = row.phase === 'question' && row.question_deadline_at
    ? currentQuestion(row)
    : null;
  const odds = question ? oddsForQuestion(question, row.cleared_zones, rules) : null;
  const currentMultiplierBp = multiplierForClearedZones(rules, row.cleared_zones);
  const nextMultiplierBp = active
    ? rules.multiplierLadderBp[row.cleared_zones] ?? null
    : null;
  const displayDeadline = row.question_deadline_at
    ? new Date(
        new Date(row.question_deadline_at).getTime() - ROAD_TO_GOAL_NETWORK_GRACE_MS
      ).toISOString()
    : null;
  const payout = decimal(row.payout_coins);

  return {
    round_id: row.id,
    status: row.status,
    phase: row.phase,
    state_version: row.state_version,
    stake_coins: row.stake_coins,
    cleared_zones: row.cleared_zones,
    total_zones: ROAD_TO_GOAL_ZONES,
    current_multiplier_bp: currentMultiplierBp,
    next_multiplier_bp: nextMultiplierBp,
    current_return_coins: active
      ? payoutForRules(rules, row.stake_coins, row.cleared_zones)
      : payout ?? 0,
    next_return_coins:
      active && row.cleared_zones < ROAD_TO_GOAL_ZONES
        ? payoutForRules(rules, row.stake_coins, row.cleared_zones + 1)
        : null,
    zone_multipliers_bp: rules.multiplierLadderBp,
    calibration_version_id: row.calibration_version_id,
    commitment_version: row.commitment_version === ROAD_TO_GOAL_COMMITMENT_VERSION
      ? row.commitment_version
      : null,
    commit_hash: row.commit_hash,
    rules_manifest_hash: row.rules_manifest_hash,
    question_set_hash: row.question_set_hash,
    client_seed: row.client_seed,
    server_seed: active ? null : row.server_seed,
    auto_cashout_zone: row.auto_cashout_zone,
    decision_deadline_at: row.decision_deadline_at,
    settlement_reason: row.settlement_reason,
    question:
      question && odds && displayDeadline
        ? {
            question_id: question.question_id,
            zone: row.cleared_zones + 1,
            difficulty: question.difficulty,
            prompt: question.prompt,
            image: question.image ?? null,
            options: question.options,
            duration_ms: ROAD_TO_GOAL_QUESTION_MS,
            deadline_at: displayDeadline,
            expected_accuracy_bp: odds.expectedAccuracyBp,
            target_survival_bp: odds.targetSurvivalBp,
            correct_survival_bp: odds.correctSurvivalBp,
            wrong_survival_bp: odds.wrongSurvivalBp,
          }
        : null,
    payout_coins: payout,
    server_now: databaseNow(row),
  };
}

function assertActive(row: RoadToGoalRoundRow): void {
  if (row.status !== 'active') throw new ConflictError('Round is already settled');
}

function assertVersion(row: RoadToGoalRoundRow, expectedVersion: number): void {
  if (row.state_version !== expectedVersion) {
    throw new ConflictError('Stale state — refresh the round');
  }
}

function questionExpired(row: RoadToGoalRoundRow): boolean {
  if (typeof row.question_expired === 'boolean') return row.question_expired;
  return Boolean(
    row.phase === 'question'
      && row.question_deadline_at
      && new Date(row.question_deadline_at).getTime() <= new Date(databaseNow(row)).getTime()
  );
}

function decisionExpired(row: RoadToGoalRoundRow): boolean {
  if (typeof row.decision_expired === 'boolean') return row.decision_expired;
  return Boolean(
    row.phase === 'decision'
      && row.decision_deadline_at
      && new Date(row.decision_deadline_at).getTime() <= new Date(databaseNow(row)).getTime()
  );
}

function answerDurationMs(row: RoadToGoalRoundRow): number | null {
  if (!row.question_deadline_at) return null;
  const dealtAt = new Date(row.question_deadline_at).getTime() - ROAD_TO_GOAL_SERVER_WINDOW_MS;
  return Math.min(
    2_147_483_647,
    Math.max(0, new Date(databaseNow(row)).getTime() - dealtAt)
  );
}

function uniqueViolation(error: unknown, constraint: string): boolean {
  const postgresError = error as PostgresErrorShape;
  return postgresError?.code === '23505'
    && (postgresError.constraint_name === constraint || postgresError.constraint === constraint);
}

async function updateOrConflict(
  tx: TransactionSql,
  row: RoadToGoalRoundRow,
  patch: Record<string, unknown>
): Promise<RoadToGoalRoundRow> {
  const updated = await roadToGoalRepo.updateRoundState(tx, row.id, row.state_version, patch);
  if (!updated) throw new ConflictError('Round state changed');
  return updated;
}

async function insertPayout(
  tx: TransactionSql,
  row: RoadToGoalRoundRow,
  payoutMinor: number,
  reason: string
): Promise<void> {
  try {
    await roadToGoalRepo.insertLedgerKey(tx, {
      idempotencyKey: roadToGoalPayoutIdempotencyKey(row.id),
      roundId: row.id,
      userId: row.user_id,
      eventType: ROAD_TO_GOAL_PAYOUT_EVENT,
    });
    await storeRepo.insertTransactionLogInTx(tx, {
      eventType: ROAD_TO_GOAL_PAYOUT_EVENT,
      outcome: 'success',
      userId: row.user_id,
      coinsDeltaMinor: payoutMinor,
      reason,
      idempotencyKey: roadToGoalPayoutIdempotencyKey(row.id),
    });
  } catch (error) {
    if ((error as PostgresErrorShape)?.code === '23505') {
      logger.error({ roundId: row.id }, 'road-to-goal payout idempotency collision');
      throw new ConflictError('Round is already settled');
    }
    throw error;
  }

  const wallet = await storeRepo.adjustWalletMinorInTx(tx, row.user_id, payoutMinor, 0);
  if (!wallet) throw new AppError('Wallet credit failed', 500);
}

async function settleWithPayout(
  tx: TransactionSql,
  row: RoadToGoalRoundRow,
  analytics: DeferredAnalytics,
  options: {
    status: 'cashed' | 'completed';
    clearedZones: number;
    eventType: 'cashout' | 'auto_cashout' | 'complete';
    reason: string;
    requestNonce?: string | null;
    deferSettlementAnalytics?: boolean;
  }
): Promise<RoadToGoalRoundRow> {
  const rules = rulesForHash(row.rules_manifest_hash);
  const payoutMinor = payoutMinorForRules(rules, row.stake_coins, options.clearedZones);
  const payout = payoutMinor / 100;
  const updated = await updateOrConflict(tx, row, {
    status: options.status,
    phase: 'settled',
    cleared_zones: options.clearedZones,
    payout_coins: payout,
    settlement_reason: options.reason,
    settled_at: databaseNow(row),
    question_deadline_at: null,
    decision_deadline_at: null,
  });
  await insertPayout(tx, row, payoutMinor, options.reason);
  await roadToGoalRepo.insertEvent(tx, {
    roundId: updated.id,
    userId: updated.user_id,
    zone: options.clearedZones,
    stateVersion: updated.state_version,
    eventType: options.eventType,
    multiplierBp: multiplierForClearedZones(rules, options.clearedZones),
    stakeCoins: row.stake_coins,
    payoutCoins: payout,
    requestNonce: options.requestNonce ?? null,
  });
  if (!options.deferSettlementAnalytics) {
    analytics.push(() => trackRoadToGoalRunSettled(updated));
  }
  return updated;
}

function requireFairnessSeeds(row: RoadToGoalRoundRow): {
  serverSeed: string;
  clientSeed: string;
} {
  if (!row.server_seed || !row.client_seed || !row.commit_hash) {
    throw new AppError('Road to Goal fairness data is missing', 500);
  }
  return { serverSeed: row.server_seed, clientSeed: row.client_seed };
}

async function resolveAttempt(
  tx: TransactionSql,
  row: RoadToGoalRoundRow,
  analytics: DeferredAnalytics,
  input: {
    answerOption: string | null;
    correct: boolean;
    outcome: 'correct' | 'wrong' | 'late';
    answerMs: number | null;
    requestNonce: string | null;
  }
): Promise<AttemptResolution> {
  const question = currentQuestion(row);
  const zoneIndex = row.cleared_zones;
  const zone = zoneIndex + 1;
  const rules = rulesForHash(row.rules_manifest_hash);
  const odds = oddsForQuestion(question, zoneIndex, rules);
  const seeds = requireFairnessSeeds(row);
  const appliedSurvivalBp = input.correct
    ? odds.correctSurvivalBp
    : odds.wrongSurvivalBp;
  const rollBp = roadToGoalZoneRollBp({
    ...seeds,
    roundId: row.id,
    zoneIndex,
  });
  const survived = roadToGoalDidSurvive(rollBp, appliedSurvivalBp);
  let updated: RoadToGoalRoundRow;

  if (!survived) {
    updated = await updateOrConflict(tx, row, {
      status: 'lost',
      phase: 'settled',
      settlement_reason: input.outcome === 'late' ? 'timeout_tackle' : 'tackle',
      settled_at: databaseNow(row),
      question_deadline_at: null,
      decision_deadline_at: null,
    });
  } else if (zone === ROAD_TO_GOAL_ZONES) {
    updated = await settleWithPayout(tx, row, analytics, {
      status: 'completed',
      clearedZones: ROAD_TO_GOAL_ZONES,
      eventType: 'complete',
      reason: 'road_to_goal_complete',
      deferSettlementAnalytics: true,
    });
  } else if (row.auto_cashout_zone === zone) {
    updated = await settleWithPayout(tx, row, analytics, {
      status: 'cashed',
      clearedZones: zone,
      eventType: 'auto_cashout',
      reason: 'road_to_goal_configured_auto_cashout',
      deferSettlementAnalytics: true,
    });
  } else {
    updated = await updateOrConflict(tx, row, {
      phase: 'decision',
      cleared_zones: zone,
      question_deadline_at: null,
      decision_deadline_at: databaseDeadlineAfter(row, ROAD_TO_GOAL_DECISION_MS),
    });
  }

  await roadToGoalRepo.insertEvent(tx, {
    roundId: updated.id,
    userId: updated.user_id,
    zone,
    stateVersion: updated.state_version,
    eventType: input.outcome === 'late' ? 'timeout' : 'answer',
    questionId: question.question_id,
    answerOption: input.answerOption,
    correctOption: question.correct_option_id,
    answerCorrect: input.correct,
    answerMs: input.answerMs,
    multiplierBp: survived
      ? multiplierForClearedZones(rules, zone)
      : multiplierForClearedZones(rules, row.cleared_zones),
    stakeCoins: row.stake_coins,
    requestNonce: input.requestNonce,
    expectedAccuracyBp: odds.expectedAccuracyBp,
    targetSurvivalBp: odds.targetSurvivalBp,
    correctSurvivalBp: odds.correctSurvivalBp,
    wrongSurvivalBp: odds.wrongSurvivalBp,
    appliedSurvivalBp,
    rollBp,
    survived,
  });

  analytics.push(() => trackRoadToGoalQuestionResolved({
    row: updated,
    question,
    zone,
    outcome: input.outcome,
    answerMs: input.answerMs,
    survived,
    expectedAccuracyBp: odds.expectedAccuracyBp,
    targetSurvivalBp: odds.targetSurvivalBp,
    correctSurvivalBp: odds.correctSurvivalBp,
    wrongSurvivalBp: odds.wrongSurvivalBp,
    appliedSurvivalBp,
    rollBp,
  }));
  if (updated.status !== 'active') {
    analytics.push(() => trackRoadToGoalRunSettled(updated));
  }

  return {
    row: updated,
    result: {
      outcome: input.outcome,
      correct_option_id: question.correct_option_id,
      survived,
      expected_accuracy_bp: odds.expectedAccuracyBp,
      target_survival_bp: odds.targetSurvivalBp,
      correct_survival_bp: odds.correctSurvivalBp,
      wrong_survival_bp: odds.wrongSurvivalBp,
      applied_survival_bp: appliedSurvivalBp,
      roll_bp: rollBp,
    },
  };
}

async function settleTimedOutQuestion(
  tx: TransactionSql,
  row: RoadToGoalRoundRow,
  analytics: DeferredAnalytics,
  requestNonce: string | null = null
): Promise<AttemptResolution> {
  return resolveAttempt(tx, row, analytics, {
    answerOption: null,
    correct: false,
    outcome: 'late',
    answerMs: answerDurationMs(row),
    requestNonce,
  });
}

async function settleExpiredDecision(
  tx: TransactionSql,
  row: RoadToGoalRoundRow,
  analytics: DeferredAnalytics,
  requestNonce: string | null = null
): Promise<RoadToGoalRoundRow> {
  return settleWithPayout(tx, row, analytics, {
    status: 'cashed',
    clearedZones: row.cleared_zones,
    eventType: 'auto_cashout',
    reason: 'road_to_goal_decision_timeout',
    requestNonce,
  });
}

async function resolveExpiredRound(
  tx: TransactionSql,
  row: RoadToGoalRoundRow,
  analytics: DeferredAnalytics
): Promise<RoadToGoalRoundRow> {
  if (questionExpired(row)) return (await settleTimedOutQuestion(tx, row, analytics)).row;
  if (decisionExpired(row)) return settleExpiredDecision(tx, row, analytics);
  return row;
}

async function resolveStartNonceReplay(
  tx: TransactionSql,
  row: RoadToGoalRoundRow,
  analytics: DeferredAnalytics,
  input: { commitmentId: string; clientNonce: string; clientSeed: string }
): Promise<RoadToGoalRoundRow> {
  if (
    row.id !== input.commitmentId
    || row.client_nonce !== input.clientNonce
    || row.client_seed !== input.clientSeed
  ) {
    throw new ConflictError('Client nonce was already used with a different commitment');
  }
  return row.status === 'active' ? resolveExpiredRound(tx, row, analytics) : row;
}

function commitmentExpired(row: RoadToGoalCommitmentRow): boolean {
  return new Date(row.expires_at).getTime() <= new Date(databaseNow(row)).getTime();
}

function assertCommitmentSettings(
  row: RoadToGoalCommitmentRow,
  input: { stakeCoins: number; autoCashoutZone: number | null }
): void {
  if (
    row.stake_coins !== input.stakeCoins
    || row.auto_cashout_zone !== input.autoCashoutZone
  ) {
    throw new ConflictError('Request nonce was already used with different commitment settings');
  }
}

function assertSupportedCommitment(row: RoadToGoalCommitmentRow): void {
  const storedRulesManifestHash = roadToGoalRulesManifestHash(row.rules_manifest);
  const supportedRules = roadToGoalRulesManifestByHash(storedRulesManifestHash);
  const questions = readCommittedQuestionSet(row);
  const saltsValid = questions.every((question) => /^[0-9a-f]{64}$/i.test(question.commitment_salt));
  const questionSetHash = roadToGoalQuestionSetHash(questions);
  const expectedCommitHash = roadToGoalServerSeedCommitment({
    commitmentVersion: row.commitment_version,
    serverSeed: row.server_seed,
    roundId: row.round_id,
    calibrationVersionId: row.calibration_version_id,
    rulesManifestHash: row.rules_manifest_hash,
    questionSetHash: row.question_set_hash,
    stakeCoins: row.stake_coins,
    autoCashoutZone: row.auto_cashout_zone,
  });
  if (
    !supportedRules
    || !saltsValid
    || row.commitment_version !== supportedRules.version
    || row.rules_manifest_hash !== storedRulesManifestHash
    || row.question_set_hash !== questionSetHash
    || row.commit_hash !== expectedCommitHash
  ) {
    throw new AppError('Road to Goal commitment does not match a supported ruleset', 500);
  }
}

export async function buildCalibratedQuestionSet(
  tx: TransactionSql,
  userId: string,
  calibrationVersionId: string,
  options: { logSelection?: boolean } = {}
): Promise<{
  questions: RoadToGoalQuestionSnapshot[];
  calibrationVersionId: string;
}> {
  const calibrationVersion = await roadToGoalRepo.getCalibrationVersionById(
    tx,
    calibrationVersionId
  );
  if (!calibrationVersion) {
    throw new AppError('Road to Goal calibration version is unavailable', 503);
  }
  assertCalibrationVersion(calibrationVersion);
  const startedAt = performance.now();
  let queryCount = 0;
  const selectQuestionSet = async (mode: 'unseen' | 'least_exposed') => {
    const candidates: RoadToGoalQuestionCandidate[] = [];
    const excludedQuestionIds = new Set<string>();
    const candidatesPerDifficulty = mode === 'least_exposed'
      ? ROAD_TO_GOAL_FALLBACK_CANDIDATES_PER_DIFFICULTY
      : ROAD_TO_GOAL_CANDIDATES_PER_DIFFICULTY;
    for (let page = 0; page < ROAD_TO_GOAL_MAX_CANDIDATE_PAGES; page += 1) {
      queryCount += 2;
      const selected = await roadToGoalRepo.pickRunQuestionCandidates(
        tx,
        userId,
        mode,
        [...excludedQuestionIds],
        candidatesPerDifficulty
      );
      if (selected.length === 0) break;
      selected.forEach((candidate) => excludedQuestionIds.add(candidate.id));
      const calibrated = await roadToGoalRepo.filterCandidatesForCalibration(
        tx,
        calibrationVersion.id,
        selected
      );
      const priorityOffset = page * candidatesPerDifficulty;
      candidates.push(...calibrated.map((candidate) => ({
        ...candidate,
        ...(mode === 'least_exposed' && candidate.selection_priority != null
          ? { selection_priority: candidate.selection_priority + priorityOffset }
          : {}),
      })));
      const questions = buildRoadToGoalQuestionSet(candidates, Math.random, mode);
      if (questions) return { candidates, questions };
    }
    return { candidates, questions: null };
  };
  let selection = await selectQuestionSet('unseen');

  if (!selection.questions) {
    selection = await selectQuestionSet('least_exposed');
  }

  const queryMs = performance.now() - startedAt;
  if (options.logSelection !== false) {
    const log = queryMs > 50 ? logger.warn.bind(logger) : logger.debug.bind(logger);
    log(
      {
        userId,
        queryMs: Math.round(queryMs * 100) / 100,
        queryCount,
        candidates: selection.candidates.length,
      },
      'road-to-goal question set selected'
    );
  }

  if (!selection.questions) {
    throw new AppError('No eligible Road to Goal questions available', 503);
  }
  const calibrations = await roadToGoalRepo.getQuestionCalibrations(
    tx,
    calibrationVersion.id,
    selection.questions.map((question, index) => ({
      questionId: question.question_id,
      zone: index + 1,
    }))
  );
  return {
    questions: applyQuestionCalibrations(selection.questions, calibrations),
    calibrationVersionId: calibrationVersion.id,
  };
}

function replayAnswerResult(
  event: RoadToGoalEventRow,
  row: RoadToGoalRoundRow
): RoadToGoalAnswerResult {
  if (
    (event.event_type !== 'answer' && event.event_type !== 'timeout')
    || !event.correct_option
    || event.survived == null
    || event.expected_accuracy_bp == null
    || event.target_survival_bp == null
    || event.correct_survival_bp == null
    || event.wrong_survival_bp == null
    || event.applied_survival_bp == null
    || event.roll_bp == null
  ) {
    throw new ConflictError('Request nonce was already used for another action');
  }
  return {
    outcome: event.event_type === 'timeout'
      ? 'late'
      : event.answer_correct ? 'correct' : 'wrong',
    correct_option_id: event.correct_option,
    survived: event.survived,
    expected_accuracy_bp: event.expected_accuracy_bp,
    target_survival_bp: event.target_survival_bp,
    correct_survival_bp: event.correct_survival_bp,
    wrong_survival_bp: event.wrong_survival_bp,
    applied_survival_bp: event.applied_survival_bp,
    roll_bp: event.roll_bp,
    state: toPublicState(row),
  };
}

export const roadToGoalService = {
  async prepareCommitment(
    userId: string,
    input: {
      stakeCoins: number;
      requestNonce: string;
      autoCashoutZone: number | null;
    }
  ): Promise<RoadToGoalPreparedCommitment> {
    if (!isRoadToGoalStake(input.stakeCoins)) {
      throw new BadRequestError('Stake must be 10, 25, or 50 coins');
    }

    try {
      return await sql.begin(async (tx) => {
      await roadToGoalRepo.expirePreparedCommitments(tx, userId);
      const replay = await roadToGoalRepo.getCommitmentByNonceForUpdate(
        tx,
        userId,
        input.requestNonce
      );
      if (replay) {
        assertCommitmentSettings(replay, input);
        if (replay.status === 'expired' || commitmentExpired(replay)) {
          throw new ConflictError('Commitment expired; prepare a new one with a new nonce');
        }
        return toPreparedCommitment(replay);
      }

      const existing = await roadToGoalRepo.getPreparedCommitmentForUserForUpdate(tx, userId);
      if (existing) {
        assertCommitmentSettings(existing, input);
        return toPreparedCommitment(existing);
      }

      const calibration = await ensureRoadToGoalDailyCalibration(tx);
      const { questions, calibrationVersionId } = await buildCalibratedQuestionSet(
        tx,
        userId,
        calibration.id
      );
      const questionSetHash = roadToGoalQuestionSetHash(questions);
      const roundId = randomUUID();
      const serverSeed = newRoadToGoalServerSeed();
      const rulesManifestHash = roadToGoalRulesManifestHash();
      const commitHash = roadToGoalServerSeedCommitment({
        serverSeed,
        roundId,
        calibrationVersionId,
        rulesManifestHash,
        questionSetHash,
        stakeCoins: input.stakeCoins,
        autoCashoutZone: input.autoCashoutZone,
      });
      const commitment = await roadToGoalRepo.insertCommitment(tx, {
        roundId,
        userId,
        requestNonce: input.requestNonce,
        stakeCoins: input.stakeCoins,
        autoCashoutZone: input.autoCashoutZone,
        calibrationVersionId,
        commitmentVersion: ROAD_TO_GOAL_COMMITMENT_VERSION,
        serverSeed,
        commitHash,
        rulesManifest: ROAD_TO_GOAL_RULES_MANIFEST,
        rulesManifestHash,
        runQuestions: questions,
        questionSetHash,
        expiresInMs: ROAD_TO_GOAL_COMMITMENT_MS,
      });
        return toPreparedCommitment(commitment);
      });
    } catch (error) {
      const nonceConflict = uniqueViolation(
        error,
        'road_to_goal_commitments_user_id_request_nonce_key'
      );
      const preparedConflict = uniqueViolation(error, 'uq_road_to_goal_prepared_commitment');
      if (!nonceConflict && !preparedConflict) throw error;
      return sql.begin(async (tx) => {
        const replay = await roadToGoalRepo.getCommitmentByNonceForUpdate(
          tx,
          userId,
          input.requestNonce
        );
        if (replay) {
          assertCommitmentSettings(replay, input);
          return toPreparedCommitment(replay);
        }
        const existing = await roadToGoalRepo.getPreparedCommitmentForUserForUpdate(tx, userId);
        if (existing) {
          assertCommitmentSettings(existing, input);
          return toPreparedCommitment(existing);
        }
        throw new ConflictError('A prepared Road to Goal commitment already exists');
      });
    }
  },

  async startRound(
    userId: string,
    input: {
      commitmentId: string;
      clientNonce: string;
      clientSeed: string;
    }
  ): Promise<RoadToGoalPublicState> {
    try {
      return await withRoadToGoalAnalytics(async (tx, analytics) => {
        const replay = await roadToGoalRepo.getRoundByNonceForUpdate(
          tx,
          userId,
          input.clientNonce
        );
        if (replay) {
          return toPublicState(await resolveStartNonceReplay(tx, replay, analytics, input));
        }

        const commitment = await roadToGoalRepo.getCommitmentForUpdate(
          tx,
          userId,
          input.commitmentId
        );
        if (!commitment) throw new NotFoundError('Road to Goal commitment not found');
        if (commitment.status === 'consumed') {
          const consumedRound = await roadToGoalRepo.getRoundForUserForUpdate(
            tx,
            userId,
            input.commitmentId
          );
          if (consumedRound) {
            return toPublicState(
              await resolveStartNonceReplay(tx, consumedRound, analytics, input)
            );
          }
          throw new ConflictError('Commitment is already consumed');
        }
        if (commitment.status !== 'prepared' || commitmentExpired(commitment)) {
          throw new ConflictError('Commitment expired; prepare a new one');
        }
        assertSupportedCommitment(commitment);

        const active = await roadToGoalRepo.getActiveRoundForUpdate(tx, userId);
        if (active) {
          const resolved = await resolveExpiredRound(tx, active, analytics);
          if (resolved.status === 'active') {
            throw new ConflictError('An active round already exists');
          }
        }

        const questions = readCommittedQuestionSet(commitment);
        const calibrationVersionId = commitment.calibration_version_id;
        const round = await roadToGoalRepo.insertRound(tx, {
          roundId: commitment.round_id,
          userId,
          stakeCoins: commitment.stake_coins,
          runQuestions: questions,
          clientNonce: input.clientNonce,
          calibrationVersionId,
          serverSeed: commitment.server_seed,
          commitHash: commitment.commit_hash,
          clientSeed: input.clientSeed,
          autoCashoutZone: commitment.auto_cashout_zone,
          commitmentVersion: commitment.commitment_version,
          rulesManifestHash: commitment.rules_manifest_hash,
          questionSetHash: commitment.question_set_hash,
        });
        await roadToGoalRepo.insertLedgerKey(tx, {
          idempotencyKey: roadToGoalStakeIdempotencyKey(round.id),
          roundId: round.id,
          userId,
          eventType: ROAD_TO_GOAL_STAKE_EVENT,
        });
        const consumed = await roadToGoalRepo.consumeCommitment(tx, commitment.round_id);
        if (!consumed) throw new ConflictError('Commitment expired before round creation');
        const firstQuestion = questions[0];
        if (!firstQuestion) throw new AppError('Road to Goal question snapshot is incomplete', 500);
        await roadToGoalRepo.recordQuestionExposures(tx, userId, round.id, [firstQuestion]);

        const wallet = await storeRepo.adjustWalletMinorInTx(
          tx,
          userId,
          -commitment.stake_coins * 100,
          0
        );
        if (!wallet) throw new BadRequestError('Not enough coins');

        await storeRepo.insertTransactionLogInTx(tx, {
          eventType: ROAD_TO_GOAL_STAKE_EVENT,
          outcome: 'success',
          userId,
          coinsDeltaMinor: -commitment.stake_coins * 100,
          reason: 'road_to_goal_stake',
          idempotencyKey: roadToGoalStakeIdempotencyKey(round.id),
        });
        await roadToGoalRepo.insertEvent(tx, {
          roundId: round.id,
          userId,
          zone: 1,
          stateVersion: round.state_version,
          eventType: 'start',
          stakeCoins: commitment.stake_coins,
          clientNonce: input.clientNonce,
        });
        await roadToGoalRepo.insertEvent(tx, {
          roundId: round.id,
          userId,
          zone: 1,
          stateVersion: round.state_version,
          eventType: 'question_dealt',
          questionId: firstQuestion.question_id,
        });
        analytics.push(() => trackRoadToGoalRunStarted(round));
        return toPublicState(round);
      });
    } catch (error) {
      const nonceConflict = uniqueViolation(error, 'uq_road_to_goal_user_nonce');
      const activeConflict = uniqueViolation(error, 'uq_road_to_goal_active_round');
      if (nonceConflict || activeConflict) {
        return withRoadToGoalAnalytics(async (tx, analytics) => {
          const replay = await roadToGoalRepo.getRoundByNonceForUpdate(
            tx,
            userId,
            input.clientNonce
          );
          if (replay) {
            return toPublicState(await resolveStartNonceReplay(tx, replay, analytics, input));
          }
          if (activeConflict) throw new ConflictError('An active round already exists');
          throw new ConflictError('Client nonce was already used with a different commitment');
        });
      }
      throw error;
    }
  },

  async getCurrentState(userId: string): Promise<RoadToGoalPublicState> {
    return withRoadToGoalAnalytics(async (tx, analytics) => {
      const row = await roadToGoalRepo.getActiveRoundForUpdate(tx, userId);
      if (!row) throw new NotFoundError('No active Road to Goal round');
      return toPublicState(await resolveExpiredRound(tx, row, analytics));
    });
  },

  async getRoundState(userId: string, roundId: string): Promise<RoadToGoalPublicState> {
    return withRoadToGoalAnalytics(async (tx, analytics) => {
      const row = await roadToGoalRepo.getRoundForUserForUpdate(tx, userId, roundId);
      if (!row) throw new NotFoundError('Road to Goal round not found');
      return toPublicState(
        row.status === 'active' ? await resolveExpiredRound(tx, row, analytics) : row
      );
    });
  },

  async answerQuestion(
    userId: string,
    input: {
      roundId: string;
      questionId: string;
      optionId: string;
      expectedVersion: number;
      requestNonce: string;
    }
  ): Promise<RoadToGoalAnswerResult> {
    return withRoadToGoalAnalytics(async (tx, analytics) => {
      const row = await roadToGoalRepo.getRoundForUserForUpdate(tx, userId, input.roundId);
      if (!row) throw new NotFoundError('Road to Goal round not found');
      const replay = await roadToGoalRepo.getEventByRequestNonce(
        tx,
        row.id,
        input.requestNonce
      );
      if (replay) {
        if (replay.question_id !== input.questionId || replay.answer_option !== input.optionId) {
          throw new ConflictError('Request nonce was already used with another answer');
        }
        return replayAnswerResult(replay, row);
      }

      assertActive(row);
      assertVersion(row, input.expectedVersion);
      if (row.phase !== 'question') throw new ConflictError('No question is pending');

      const question = currentQuestion(row);
      if (question.question_id !== input.questionId) {
        throw new ConflictError('Answer targets a stale question');
      }
      if (!question.options.some((option) => option.id === input.optionId)) {
        throw new BadRequestError('Option does not belong to the current question');
      }

      const late = questionExpired(row);
      const correct = !late && input.optionId === question.correct_option_id;
      const resolved = await resolveAttempt(tx, row, analytics, {
        answerOption: input.optionId,
        correct,
        outcome: late ? 'late' : correct ? 'correct' : 'wrong',
        answerMs: answerDurationMs(row),
        requestNonce: input.requestNonce,
      });
      return { ...resolved.result, state: toPublicState(resolved.row) };
    });
  },

  async continueRound(
    userId: string,
    input: { roundId: string; expectedVersion: number; requestNonce: string }
  ): Promise<RoadToGoalPublicState> {
    return withRoadToGoalAnalytics(async (tx, analytics) => {
      const row = await roadToGoalRepo.getRoundForUserForUpdate(tx, userId, input.roundId);
      if (!row) throw new NotFoundError('Road to Goal round not found');
      const replay = await roadToGoalRepo.getEventByRequestNonce(
        tx,
        row.id,
        input.requestNonce
      );
      if (replay) {
        if (replay.event_type !== 'continue' && replay.event_type !== 'auto_cashout') {
          throw new ConflictError('Request nonce was already used for another action');
        }
        return toPublicState(row);
      }

      assertActive(row);
      assertVersion(row, input.expectedVersion);
      if (row.phase !== 'decision' || row.cleared_zones <= 0) {
        throw new ConflictError('Round cannot continue now');
      }
      if (decisionExpired(row)) {
        return toPublicState(
          await settleExpiredDecision(tx, row, analytics, input.requestNonce)
        );
      }
      if (row.cleared_zones >= ROAD_TO_GOAL_ZONES) {
        throw new ConflictError('All zones are already cleared');
      }

      const question = currentQuestion(row);
      const updated = await updateOrConflict(tx, row, {
        phase: 'question',
        question_deadline_at: databaseDeadlineAfter(row, ROAD_TO_GOAL_SERVER_WINDOW_MS),
        decision_deadline_at: null,
      });
      await roadToGoalRepo.recordQuestionExposures(tx, userId, updated.id, [question]);
      await roadToGoalRepo.insertEvent(tx, {
        roundId: updated.id,
        userId,
        zone: updated.cleared_zones + 1,
        stateVersion: updated.state_version,
        eventType: 'continue',
        multiplierBp: multiplierForClearedZones(
          rulesForHash(updated.rules_manifest_hash),
          updated.cleared_zones
        ),
        requestNonce: input.requestNonce,
      });
      await roadToGoalRepo.insertEvent(tx, {
        roundId: updated.id,
        userId,
        zone: updated.cleared_zones + 1,
        stateVersion: updated.state_version,
        eventType: 'question_dealt',
        questionId: question.question_id,
      });
      return toPublicState(updated);
    });
  },

  async cashout(
    userId: string,
    input: { roundId: string; expectedVersion: number; requestNonce: string }
  ): Promise<RoadToGoalPublicState> {
    return withRoadToGoalAnalytics(async (tx, analytics) => {
      const row = await roadToGoalRepo.getRoundForUserForUpdate(tx, userId, input.roundId);
      if (!row) throw new NotFoundError('Road to Goal round not found');
      const replay = await roadToGoalRepo.getEventByRequestNonce(
        tx,
        row.id,
        input.requestNonce
      );
      if (replay) {
        if (replay.event_type !== 'cashout' && replay.event_type !== 'auto_cashout') {
          throw new ConflictError('Request nonce was already used for another action');
        }
        return toPublicState(row);
      }

      assertActive(row);
      assertVersion(row, input.expectedVersion);
      if (row.phase !== 'decision' || row.cleared_zones <= 0) {
        throw new ConflictError('Nothing can be cashed out now');
      }
      const expired = decisionExpired(row);
      return toPublicState(
        await settleWithPayout(tx, row, analytics, {
          status: 'cashed',
          clearedZones: row.cleared_zones,
          eventType: expired ? 'auto_cashout' : 'cashout',
          reason: expired ? 'road_to_goal_decision_timeout' : 'road_to_goal_cashout',
          requestNonce: input.requestNonce,
        })
      );
    });
  },

  async getProof(userId: string, roundId: string): Promise<RoadToGoalProof> {
    return sql.begin(async (tx) => {
      const row = await roadToGoalRepo.getRoundForUserForUpdate(tx, userId, roundId);
      if (!row) throw new NotFoundError('Road to Goal round not found');
      if (row.status === 'active') throw new ConflictError('Proof is available after settlement');
      if (!row.server_seed || !row.commit_hash || !row.client_seed) {
        throw new AppError('Road to Goal proof data is missing', 500);
      }
      const commitment = await roadToGoalRepo.getCommitmentForProof(tx, userId, row.id);
      if (!commitment) throw new AppError('Road to Goal commitment proof is missing', 500);
      assertSupportedCommitment(commitment);
      if (
        row.commitment_version !== commitment.commitment_version
        || row.rules_manifest_hash !== commitment.rules_manifest_hash
        || row.question_set_hash !== commitment.question_set_hash
        || row.commit_hash !== commitment.commit_hash
      ) {
        throw new AppError('Road to Goal round commitment proof is inconsistent', 500);
      }
      const events = await roadToGoalRepo.getProofEvents(tx, row.id);
      const committedQuestions = readCommittedQuestionSet(commitment);
      const questionHashes = roadToGoalQuestionHashes(committedQuestions);
      if (events.some((event, index) => event.zone !== index + 1)) {
        throw new AppError('Road to Goal zone proof sequence is invalid', 500);
      }
      return {
        version: ROAD_TO_GOAL_COMMITMENT_VERSION,
        round_id: row.id,
        calibration_version_id: row.calibration_version_id,
        commitment_version: commitment.commitment_version,
        commit_hash: row.commit_hash,
        rules_manifest: commitment.rules_manifest as unknown as typeof ROAD_TO_GOAL_RULES_MANIFEST,
        rules_manifest_hash: commitment.rules_manifest_hash,
        question_set_hash: commitment.question_set_hash,
        question_hashes: questionHashes,
        stake_coins: commitment.stake_coins,
        auto_cashout_zone: commitment.auto_cashout_zone,
        question_set: committedQuestions.slice(0, events.length).map((question, index) => ({
          zone: index + 1,
          commitment_salt: question.commitment_salt,
          question_id: question.question_id,
          difficulty: question.difficulty,
          prompt: question.prompt,
          image: question.image ?? null,
          options: question.options,
          correct_option_id: question.correct_option_id,
          expected_accuracy_bp: question.expected_accuracy_bp,
          calibration_source: question.calibration_source,
        })),
        server_seed: row.server_seed,
        client_seed: row.client_seed,
        status: row.status,
        payout_coins: decimal(row.payout_coins) ?? 0,
        cleared_zones: row.cleared_zones,
        zones: events.map((event) => {
          if (
            !event.question_id
            || !event.correct_option
            || event.survived == null
            || event.expected_accuracy_bp == null
            || event.target_survival_bp == null
            || event.correct_survival_bp == null
            || event.wrong_survival_bp == null
            || event.applied_survival_bp == null
            || event.roll_bp == null
          ) {
            throw new AppError('Road to Goal zone proof is incomplete', 500);
          }
          return {
            zone: event.zone,
            question_id: event.question_id,
            answer_option_id: event.answer_option,
            correct_option_id: event.correct_option,
            outcome: event.event_type === 'timeout'
              ? 'late'
              : event.answer_correct ? 'correct' : 'wrong',
            expected_accuracy_bp: event.expected_accuracy_bp,
            target_survival_bp: event.target_survival_bp,
            correct_survival_bp: event.correct_survival_bp,
            wrong_survival_bp: event.wrong_survival_bp,
            applied_survival_bp: event.applied_survival_bp,
            roll_bp: event.roll_bp,
            survived: event.survived,
          };
        }),
      };
    });
  },

  async heartbeat(userId: string): Promise<void> {
    await roadToGoalRepo.touchLastSeen(userId);
  },

  publishDailyCalibration: publishRoadToGoalDailyCalibration,

  async sweepStaleRounds(): Promise<{ settled: number }> {
    let settled = 0;
    let attempts = 0;
    let drained = false;
    const failedRoundIds: string[] = [];
    const deadline = performance.now() + ROAD_TO_GOAL_SWEEP_BUDGET_MS;
    while (
      attempts < ROAD_TO_GOAL_MAX_SWEEP_ATTEMPTS
      && performance.now() < deadline
    ) {
      attempts += 1;
      let claimedRoundId: string | null = null;
      try {
        const didSettle = await withRoadToGoalAnalytics(async (tx, analytics) => {
          const row = await roadToGoalRepo.getNextExpiredRoundForUpdateSkipLocked(
            tx,
            failedRoundIds
          );
          if (!row) return false;
          claimedRoundId = row.id;
          if (questionExpired(row)) {
            await settleTimedOutQuestion(tx, row, analytics);
            return true;
          }
          if (decisionExpired(row)) {
            await settleExpiredDecision(tx, row, analytics);
            return true;
          }
          return false;
        });
        if (!didSettle) {
          drained = true;
          break;
        }
        settled += 1;
      } catch (error) {
        logger.error({ roundId: claimedRoundId, error }, 'road-to-goal expiry sweep failed');
        if (!claimedRoundId) break;
        failedRoundIds.push(claimedRoundId);
      }
    }
    if (!drained) {
      logger.warn(
        { settled, attempts, failedRounds: failedRoundIds.length },
        'road-to-goal expiry sweep budget exhausted before backlog drained'
      );
    }
    return { settled };
  },
};
