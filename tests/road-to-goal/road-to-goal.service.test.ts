import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

const dbMocks = vi.hoisted(() => {
  const tx = { kind: 'test-transaction' };
  const sql = {
    begin: vi.fn(async (callback: (transaction: unknown) => unknown) => callback(tx)),
  };
  return { sql, tx };
});

const analyticsMocks = vi.hoisted(() => ({
  trackRoadToGoalRunStarted: vi.fn(),
  trackRoadToGoalQuestionResolved: vi.fn(),
  trackRoadToGoalRunSettled: vi.fn(),
}));

vi.mock('../../src/db/index.js', () => ({ sql: dbMocks.sql }));

vi.mock('../../src/modules/road-to-goal/road-to-goal.analytics.js', () => analyticsMocks);

vi.mock('../../src/modules/road-to-goal/road-to-goal.repo.js', () => ({
  roadToGoalRepo: {
    insertLedgerKey: vi.fn(),
    getRoundByNonceForUpdate: vi.fn(),
    getActiveRoundForUpdate: vi.fn(),
    getRoundForUserForUpdate: vi.fn(),
    getNextExpiredRoundForUpdateSkipLocked: vi.fn(),
    insertRound: vi.fn(),
    updateRoundState: vi.fn(),
    touchLastSeen: vi.fn(),
    insertEvent: vi.fn(),
    getEventByRequestNonce: vi.fn(),
    getProofEvents: vi.fn(),
    recordQuestionExposures: vi.fn(),
    pickRunQuestionCandidates: vi.fn(),
    filterCandidatesForCalibration: vi.fn(),
    expirePreparedCommitments: vi.fn(),
    getCommitmentByNonceForUpdate: vi.fn(),
    getPreparedCommitmentForUserForUpdate: vi.fn(),
    getCommitmentForUpdate: vi.fn(),
    getCommitmentForProof: vi.fn(),
    insertCommitment: vi.fn(),
    consumeCommitment: vi.fn(),
    getCalibrationVersionForDay: vi.fn(),
    getCalibrationVersionById: vi.fn(),
    getDatabasePublicationDay: vi.fn(),
    lockCalibrationPublisher: vi.fn(),
    insertCalibrationVersion: vi.fn(),
    insertQuestionCalibrations: vi.fn(),
    getQuestionCalibrations: vi.fn(),
  },
}));

vi.mock('../../src/modules/store/store.repo.js', () => ({
  storeRepo: {
    adjustWalletMinorInTx: vi.fn(),
    insertTransactionLogInTx: vi.fn(),
  },
}));

import { roadToGoalRepo } from '../../src/modules/road-to-goal/road-to-goal.repo.js';
import { roadToGoalService } from '../../src/modules/road-to-goal/road-to-goal.service.js';
import { buildRoadToGoalQuestionSet } from '../../src/modules/road-to-goal/road-to-goal.questions.js';
import {
  calculateRoadToGoalSurvivalOdds,
  ROAD_TO_GOAL_RULES_MANIFEST,
  roadToGoalQuestionSetHash,
  roadToGoalRulesManifestHash,
  roadToGoalServerSeedCommitment,
  roadToGoalZoneRollBp,
} from '../../src/modules/road-to-goal/road-to-goal.fairness.js';
import {
  ROAD_TO_GOAL_COMMITMENT_VERSION,
  ROAD_TO_GOAL_MULTIPLIERS_BP,
} from '../../src/modules/road-to-goal/road-to-goal.constants.js';
import type {
  RoadToGoalCommitmentRow,
  RoadToGoalDifficulty,
  RoadToGoalEventRow,
  RoadToGoalQuestionCandidate,
  RoadToGoalRoundRow,
} from '../../src/modules/road-to-goal/road-to-goal.types.js';
import { storeRepo } from '../../src/modules/store/store.repo.js';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROUND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NONCE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REQUEST_NONCE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CLIENT_SEED = 'player-controlled-seed';
const CALIBRATION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const COMMITMENT_NONCE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function candidate(id: number, difficulty: RoadToGoalDifficulty): RoadToGoalQuestionCandidate {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    difficulty,
    prompt: { en: `Question ${id}`, ka: `კითხვა ${id}` },
    payload: {
      options: [0, 1, 2, 3].map((option) => ({
        id: `option-${id}-${option}`,
        text: { en: `Option ${option}`, ka: `პასუხი ${option}` },
        is_correct: option === 1,
      })),
    },
  };
}

const candidates = [
  ...Array.from({ length: 6 }, (_, index) => candidate(index + 1, 'easy')),
  ...Array.from({ length: 6 }, (_, index) => candidate(index + 20, 'medium')),
  ...Array.from({ length: 5 }, (_, index) => candidate(index + 40, 'hard')),
];
const questionSet = buildRoadToGoalQuestionSet(candidates, () => 0.5)!;
const DEFAULT_SEED = 'ab'.repeat(32);
const RULES_HASH = roadToGoalRulesManifestHash();
const QUESTION_SET_HASH = roadToGoalQuestionSetHash(questionSet);

function commitment(overrides: Partial<RoadToGoalCommitmentRow> = {}): RoadToGoalCommitmentRow {
  const serverSeed = overrides.server_seed ?? DEFAULT_SEED;
  return {
    round_id: ROUND_ID,
    user_id: USER_ID,
    request_nonce: COMMITMENT_NONCE,
    stake_coins: 25,
    auto_cashout_zone: null,
    calibration_version_id: CALIBRATION_ID,
    commitment_version: ROAD_TO_GOAL_COMMITMENT_VERSION,
    server_seed: serverSeed,
    commit_hash: roadToGoalServerSeedCommitment({
      serverSeed,
      roundId: ROUND_ID,
      calibrationVersionId: CALIBRATION_ID,
      rulesManifestHash: RULES_HASH,
      questionSetHash: QUESTION_SET_HASH,
      stakeCoins: 25,
      autoCashoutZone: null,
    }),
    rules_manifest: ROAD_TO_GOAL_RULES_MANIFEST as never,
    rules_manifest_hash: RULES_HASH,
    run_questions: questionSet as never,
    question_set_hash: QUESTION_SET_HASH,
    status: 'prepared',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed_at: null,
    created_at: new Date().toISOString(),
    database_now: new Date().toISOString(),
    ...overrides,
  };
}

function round(overrides: Partial<RoadToGoalRoundRow> = {}): RoadToGoalRoundRow {
  const serverSeed = overrides.server_seed ?? DEFAULT_SEED;
  return {
    id: ROUND_ID,
    user_id: USER_ID,
    status: 'active',
    phase: 'question',
    state_version: 0,
    stake_coins: 25,
    cleared_zones: 0,
    run_questions: questionSet as never,
    question_deadline_at: new Date(Date.now() + 10_000).toISOString(),
    client_nonce: NONCE,
    payout_coins: null,
    calibration_version_id: CALIBRATION_ID,
    server_seed: serverSeed,
    commit_hash: roadToGoalServerSeedCommitment({
      serverSeed,
      roundId: ROUND_ID,
      calibrationVersionId: CALIBRATION_ID,
      rulesManifestHash: RULES_HASH,
      questionSetHash: QUESTION_SET_HASH,
      stakeCoins: 25,
      autoCashoutZone: null,
    }),
    commitment_version: ROAD_TO_GOAL_COMMITMENT_VERSION,
    rules_manifest_hash: RULES_HASH,
    question_set_hash: QUESTION_SET_HASH,
    client_seed: CLIENT_SEED,
    auto_cashout_zone: null,
    decision_deadline_at: null,
    settlement_reason: null,
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    settled_at: null,
    ...overrides,
  };
}

const calibrationVersion = {
  id: CALIBRATION_ID,
  publication_day: new Date().toISOString().slice(0, 10),
  rules_version: 2,
  target_rtp_bp: 9_800,
  skill_gap_bp: 1_000,
  easy_prior_bp: 8_000,
  medium_prior_bp: 6_500,
  hard_prior_bp: 5_000,
  minimum_accuracy_bp: 3_500,
  maximum_accuracy_bp: 9_500,
  minimum_survival_bp: 50,
  maximum_survival_bp: 9_950,
  minimum_road_answers: 100,
  config: {},
  created_at: new Date().toISOString(),
};

function startInput() {
  return {
    commitmentId: ROUND_ID,
    clientNonce: NONCE,
    clientSeed: CLIENT_SEED,
  };
}

function answerInput(row: RoadToGoalRoundRow, optionId: string) {
  return {
    roundId: row.id,
    questionId: questionSet[row.cleared_zones]!.question_id,
    optionId,
    expectedVersion: row.state_version,
    requestNonce: REQUEST_NONCE,
  };
}

function seedFor(row: RoadToGoalRoundRow, correct: boolean, shouldSurvive: boolean): string {
  const question = questionSet[row.cleared_zones]!;
  const odds = calculateRoadToGoalSurvivalOdds({
    multiplierLadderBp: ROAD_TO_GOAL_MULTIPLIERS_BP,
    zoneIndex: row.cleared_zones,
    expectedAccuracyBp: question.expected_accuracy_bp,
  });
  const survivalBp = correct ? odds.correctSurvivalBp : odds.wrongSurvivalBp;
  for (let value = 1; value < 100_000; value += 1) {
    const serverSeed = value.toString(16).padStart(64, '0');
    const rollBp = roadToGoalZoneRollBp({
      serverSeed,
      clientSeed: CLIENT_SEED,
      roundId: row.id,
      zoneIndex: row.cleared_zones,
    });
    if ((rollBp < survivalBp) === shouldSurvive) return serverSeed;
  }
  throw new Error('Unable to find deterministic test seed');
}

function withOutcomeSeed(
  correct: boolean,
  shouldSurvive: boolean,
  overrides: Partial<RoadToGoalRoundRow> = {}
): RoadToGoalRoundRow {
  const base = round(overrides);
  const serverSeed = seedFor(base, correct, shouldSurvive);
  return round({
    ...overrides,
    server_seed: serverSeed,
    commit_hash: roadToGoalServerSeedCommitment({
      serverSeed,
      roundId: ROUND_ID,
      calibrationVersionId: CALIBRATION_ID,
      rulesManifestHash: RULES_HASH,
      questionSetHash: QUESTION_SET_HASH,
      stakeCoins: 25,
      autoCashoutZone: null,
    }),
  });
}

let lockedRound: RoadToGoalRoundRow;

describe('roadToGoalService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.sql.begin.mockImplementation(
      async (callback: (transaction: unknown) => unknown) => callback(dbMocks.tx)
    );
    lockedRound = round();
    (roadToGoalRepo.getRoundByNonceForUpdate as Mock).mockResolvedValue(null);
    (roadToGoalRepo.getActiveRoundForUpdate as Mock).mockImplementation(() => null);
    (roadToGoalRepo.getRoundForUserForUpdate as Mock).mockImplementation(() => lockedRound);
    (roadToGoalRepo.getNextExpiredRoundForUpdateSkipLocked as Mock).mockResolvedValue(null);
    (roadToGoalRepo.expirePreparedCommitments as Mock).mockResolvedValue(undefined);
    (roadToGoalRepo.getCommitmentByNonceForUpdate as Mock).mockResolvedValue(null);
    (roadToGoalRepo.getPreparedCommitmentForUserForUpdate as Mock).mockResolvedValue(null);
    (roadToGoalRepo.getCommitmentForUpdate as Mock).mockImplementation(() => commitment());
    (roadToGoalRepo.getCommitmentForProof as Mock).mockImplementation(() => ({
      ...commitment(),
      status: 'consumed',
      consumed_at: new Date().toISOString(),
    }));
    (roadToGoalRepo.consumeCommitment as Mock).mockImplementation(() => ({
      ...commitment(),
      status: 'consumed',
      consumed_at: new Date().toISOString(),
    }));
    (roadToGoalRepo.getEventByRequestNonce as Mock).mockResolvedValue(null);
    (roadToGoalRepo.getProofEvents as Mock).mockResolvedValue([]);
    (roadToGoalRepo.pickRunQuestionCandidates as Mock).mockResolvedValue(candidates);
    (roadToGoalRepo.filterCandidatesForCalibration as Mock)
      .mockImplementation(async (_tx, _versionId, selected) => selected);
    (roadToGoalRepo.getCalibrationVersionForDay as Mock).mockResolvedValue(calibrationVersion);
    (roadToGoalRepo.getCalibrationVersionById as Mock).mockResolvedValue(calibrationVersion);
    (roadToGoalRepo.getDatabasePublicationDay as Mock).mockResolvedValue(
      calibrationVersion.publication_day
    );
    (roadToGoalRepo.getQuestionCalibrations as Mock).mockResolvedValue([]);
    (storeRepo.adjustWalletMinorInTx as Mock).mockResolvedValue({
      coins: 975,
      coin_fraction_minor: 0,
      tickets: 5,
    });
    (storeRepo.insertTransactionLogInTx as Mock).mockResolvedValue({ id: 'ledger-1' });
    (roadToGoalRepo.insertEvent as Mock).mockResolvedValue(undefined);
    (roadToGoalRepo.insertLedgerKey as Mock).mockResolvedValue(undefined);
    (roadToGoalRepo.recordQuestionExposures as Mock).mockResolvedValue(undefined);
    (roadToGoalRepo.insertRound as Mock).mockImplementation((_tx, data) => {
      lockedRound = round({
        id: data.roundId,
        stake_coins: data.stakeCoins,
        run_questions: data.runQuestions,
        question_deadline_at: new Date(Date.now() + 16_500).toISOString(),
        client_nonce: data.clientNonce,
        calibration_version_id: data.calibrationVersionId,
        server_seed: data.serverSeed,
        commit_hash: data.commitHash,
        client_seed: data.clientSeed,
        auto_cashout_zone: data.autoCashoutZone,
        commitment_version: data.commitmentVersion,
        rules_manifest_hash: data.rulesManifestHash,
        question_set_hash: data.questionSetHash,
      });
      return lockedRound;
    });
    (roadToGoalRepo.updateRoundState as Mock).mockImplementation(
      (_tx, _roundId, expectedVersion, patch) => {
        lockedRound = round({
          ...lockedRound,
          ...patch,
          state_version: expectedVersion + 1,
        });
        return lockedRound;
      }
    );
  });

  it('starts atomically, debits minor units, and exposes only the served question', async () => {
    const state = await roadToGoalService.startRound(USER_ID, startInput());

    expect(state.phase).toBe('question');
    expect(state.question?.zone).toBe(1);
    expect(state.question?.correct_survival_bp).toBeGreaterThan(
      state.question?.wrong_survival_bp ?? 10_000
    );
    expect(state.commit_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.server_seed).toBeNull();
    expect(JSON.stringify(state)).not.toContain('correct_option_id');
    expect(roadToGoalRepo.recordQuestionExposures).toHaveBeenCalledWith(
      dbMocks.tx,
      USER_ID,
      ROUND_ID,
      [expect.objectContaining({ question_id: state.question!.question_id })]
    );
    expect(storeRepo.adjustWalletMinorInTx).toHaveBeenCalledWith(
      dbMocks.tx,
      USER_ID,
      -2_500,
      0
    );
    expect(storeRepo.insertTransactionLogInTx).toHaveBeenCalledWith(
      dbMocks.tx,
      expect.objectContaining({ coinsDeltaMinor: -2_500 })
    );
    expect(roadToGoalRepo.insertLedgerKey).toHaveBeenCalledWith(
      dbMocks.tx,
      {
        idempotencyKey: `road-to-goal:${ROUND_ID}:stake`,
        roundId: ROUND_ID,
        userId: USER_ID,
        eventType: 'road_to_goal_stake',
      }
    );
    expect(
      (roadToGoalRepo.insertLedgerKey as Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (storeRepo.adjustWalletMinorInTx as Mock).mock.invocationCallOrder[0]
    );
    expect(
      (roadToGoalRepo.insertLedgerKey as Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (storeRepo.insertTransactionLogInTx as Mock).mock.invocationCallOrder[0]
    );
    expect(analyticsMocks.trackRoadToGoalRunStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: ROUND_ID })
    );
  });

  it('does not emit authoritative analytics when the transaction commit fails', async () => {
    dbMocks.sql.begin.mockImplementationOnce(async (callback) => {
      await callback(dbMocks.tx);
      throw new Error('simulated commit failure');
    });

    await expect(roadToGoalService.startRound(USER_ID, startInput()))
      .rejects.toThrow('simulated commit failure');

    expect(analyticsMocks.trackRoadToGoalRunStarted).not.toHaveBeenCalled();
  });

  it('prepares the server commitment before accepting any player seed', async () => {
    const prepared = commitment();
    (roadToGoalRepo.insertCommitment as Mock).mockResolvedValue(prepared);

    const result = await roadToGoalService.prepareCommitment(USER_ID, {
      stakeCoins: 25,
      requestNonce: COMMITMENT_NONCE,
      autoCashoutZone: null,
    });

    expect(result.commitment_id).toBe(ROUND_ID);
    expect(result.commit_hash).toBe(prepared.commit_hash);
    const [, insertedCommitment] = (roadToGoalRepo.insertCommitment as Mock).mock.calls[0]!;
    expect(insertedCommitment).not.toHaveProperty('clientSeed');
    expect(insertedCommitment.runQuestions).toHaveLength(11);
    expect(insertedCommitment.questionSetHash).toBe(
      roadToGoalQuestionSetHash(insertedCommitment.runQuestions)
    );
    expect(storeRepo.adjustWalletMinorInTx).not.toHaveBeenCalled();
  });

  it('pages past malformed legacy candidates without using full-pool JSON filters', async () => {
    const malformed = {
      ...candidate(99, 'easy'),
      payload: { options: [{ id: 'only-one' }] },
    };
    (roadToGoalRepo.pickRunQuestionCandidates as Mock)
      .mockResolvedValueOnce([malformed])
      .mockResolvedValueOnce(candidates);
    (roadToGoalRepo.insertCommitment as Mock).mockImplementation((_tx, data) => ({
      ...commitment({ server_seed: data.serverSeed }),
      round_id: data.roundId,
      user_id: data.userId,
      request_nonce: data.requestNonce,
      stake_coins: data.stakeCoins,
      auto_cashout_zone: data.autoCashoutZone,
      calibration_version_id: data.calibrationVersionId,
      commitment_version: data.commitmentVersion,
      server_seed: data.serverSeed,
      run_questions: data.runQuestions,
      question_set_hash: data.questionSetHash,
      commit_hash: data.commitHash,
      rules_manifest: data.rulesManifest,
      rules_manifest_hash: data.rulesManifestHash,
    }));

    await roadToGoalService.prepareCommitment(USER_ID, {
      stakeCoins: 25,
      requestNonce: COMMITMENT_NONCE,
      autoCashoutZone: null,
    });

    expect(roadToGoalRepo.pickRunQuestionCandidates).toHaveBeenNthCalledWith(
      1,
      dbMocks.tx,
      USER_ID,
      'unseen',
      [],
      64
    );
    expect(roadToGoalRepo.pickRunQuestionCandidates).toHaveBeenNthCalledWith(
      2,
      dbMocks.tx,
      USER_ID,
      'unseen',
      [malformed.id],
      64
    );
    const [, insertedCommitment] = (roadToGoalRepo.insertCommitment as Mock).mock.calls[0]!;
    expect(insertedCommitment.runQuestions).toHaveLength(11);
    expect(insertedCommitment.runQuestions.map((question: { question_id: string }) => (
      question.question_id
    ))).not.toContain(malformed.id);
  });

  it('pages past candidates rejected by the immutable calibration gate', async () => {
    const staleCandidate = candidate(98, 'easy');
    (roadToGoalRepo.pickRunQuestionCandidates as Mock)
      .mockResolvedValueOnce([staleCandidate])
      .mockResolvedValueOnce(candidates);
    (roadToGoalRepo.filterCandidatesForCalibration as Mock)
      .mockResolvedValueOnce([])
      .mockImplementation(async (_tx, _versionId, selected) => selected);
    (roadToGoalRepo.insertCommitment as Mock).mockImplementation((_tx, data) => ({
      ...commitment({ server_seed: data.serverSeed }),
      round_id: data.roundId,
      user_id: data.userId,
      request_nonce: data.requestNonce,
      stake_coins: data.stakeCoins,
      auto_cashout_zone: data.autoCashoutZone,
      calibration_version_id: data.calibrationVersionId,
      commitment_version: data.commitmentVersion,
      server_seed: data.serverSeed,
      run_questions: data.runQuestions,
      question_set_hash: data.questionSetHash,
      commit_hash: data.commitHash,
      rules_manifest: data.rulesManifest,
      rules_manifest_hash: data.rulesManifestHash,
    }));

    await roadToGoalService.prepareCommitment(USER_ID, {
      stakeCoins: 25,
      requestNonce: COMMITMENT_NONCE,
      autoCashoutZone: null,
    });

    expect(roadToGoalRepo.pickRunQuestionCandidates).toHaveBeenNthCalledWith(
      2,
      dbMocks.tx,
      USER_ID,
      'unseen',
      [staleCandidate.id],
      64
    );
  });

  it('caps unseen retries and performs one widened least-exposed fallback sort', async () => {
    const malformedPages = Array.from({ length: 4 }, (_, index) => ({
      ...candidate(90 + index, 'easy'),
      payload: { options: [{ id: `malformed-${index}` }] },
    }));
    for (const malformed of malformedPages) {
      (roadToGoalRepo.pickRunQuestionCandidates as Mock).mockResolvedValueOnce([malformed]);
    }
    (roadToGoalRepo.pickRunQuestionCandidates as Mock).mockResolvedValueOnce(
      candidates.map((item, index) => ({ ...item, selection_priority: index + 1 }))
    );
    (roadToGoalRepo.insertCommitment as Mock).mockImplementation((_tx, data) => ({
      ...commitment({ server_seed: data.serverSeed }),
      round_id: data.roundId,
      user_id: data.userId,
      request_nonce: data.requestNonce,
      stake_coins: data.stakeCoins,
      auto_cashout_zone: data.autoCashoutZone,
      calibration_version_id: data.calibrationVersionId,
      commitment_version: data.commitmentVersion,
      server_seed: data.serverSeed,
      run_questions: data.runQuestions,
      question_set_hash: data.questionSetHash,
      commit_hash: data.commitHash,
      rules_manifest: data.rulesManifest,
      rules_manifest_hash: data.rulesManifestHash,
    }));

    await roadToGoalService.prepareCommitment(USER_ID, {
      stakeCoins: 25,
      requestNonce: COMMITMENT_NONCE,
      autoCashoutZone: null,
    });

    expect(roadToGoalRepo.pickRunQuestionCandidates).toHaveBeenCalledTimes(5);
    expect(roadToGoalRepo.pickRunQuestionCandidates).toHaveBeenNthCalledWith(
      4,
      dbMocks.tx,
      USER_ID,
      'unseen',
      malformedPages.slice(0, 3).map((item) => item.id),
      64
    );
    expect(roadToGoalRepo.pickRunQuestionCandidates).toHaveBeenNthCalledWith(
      5,
      dbMocks.tx,
      USER_ID,
      'least_exposed',
      [],
      128
    );
  });

  it('replays a start nonce without another query or debit', async () => {
    (roadToGoalRepo.getRoundByNonceForUpdate as Mock).mockResolvedValue(lockedRound);

    const state = await roadToGoalService.startRound(USER_ID, startInput());

    expect(state.round_id).toBe(ROUND_ID);
    expect(roadToGoalRepo.pickRunQuestionCandidates).not.toHaveBeenCalled();
    expect(storeRepo.adjustWalletMinorInTx).not.toHaveBeenCalled();
  });

  it('lets a correct answer survive with the higher published odds', async () => {
    lockedRound = withOutcomeSeed(true, true);
    const question = questionSet[0]!;

    const result = await roadToGoalService.answerQuestion(
      USER_ID,
      answerInput(lockedRound, question.correct_option_id)
    );

    expect(result.outcome).toBe('correct');
    expect(result.survived).toBe(true);
    expect(result.applied_survival_bp).toBe(result.correct_survival_bp);
    expect(result.correct_survival_bp).toBeGreaterThan(result.wrong_survival_bp);
    expect(result.state.phase).toBe('decision');
    expect(result.state.cleared_zones).toBe(1);
  });

  it('can let a wrong answer survive and advance', async () => {
    lockedRound = withOutcomeSeed(false, true);
    const question = questionSet[0]!;
    const wrong = question.options.find((option) => option.id !== question.correct_option_id)!;

    const result = await roadToGoalService.answerQuestion(
      USER_ID,
      answerInput(lockedRound, wrong.id)
    );

    expect(result.outcome).toBe('wrong');
    expect(result.survived).toBe(true);
    expect(result.applied_survival_bp).toBe(result.wrong_survival_bp);
    expect(result.state.phase).toBe('decision');
    expect(result.state.current_return_coins).toBe(25.75);
  });

  it('settles a deterministic tackle when the roll misses the applied odds', async () => {
    lockedRound = withOutcomeSeed(false, false);
    const question = questionSet[0]!;
    const wrong = question.options.find((option) => option.id !== question.correct_option_id)!;

    const result = await roadToGoalService.answerQuestion(
      USER_ID,
      answerInput(lockedRound, wrong.id)
    );

    expect(result.survived).toBe(false);
    expect(result.state.status).toBe('lost');
    expect(result.state.server_seed).toBe(lockedRound.server_seed);
    expect(storeRepo.adjustWalletMinorInTx).not.toHaveBeenCalled();
  });

  it('treats a late submission as wrong before applying the deterministic roll', async () => {
    lockedRound = withOutcomeSeed(false, true, {
      question_deadline_at: new Date(Date.now() - 1).toISOString(),
    });
    const question = questionSet[0]!;

    const result = await roadToGoalService.answerQuestion(
      USER_ID,
      answerInput(lockedRound, question.correct_option_id)
    );

    expect(result.outcome).toBe('late');
    expect(result.applied_survival_bp).toBe(result.wrong_survival_bp);
    expect(roadToGoalRepo.insertEvent).toHaveBeenCalledWith(
      dbMocks.tx,
      expect.objectContaining({ eventType: 'timeout', answerCorrect: false })
    );
  });

  it('replays an answered mutation from its stable request nonce', async () => {
    const event = {
      event_type: 'answer',
      question_id: questionSet[0]!.question_id,
      answer_option: questionSet[0]!.correct_option_id,
      correct_option: questionSet[0]!.correct_option_id,
      answer_correct: true,
      survived: true,
      expected_accuracy_bp: 8_000,
      target_survival_bp: 9_515,
      correct_survival_bp: 9_715,
      wrong_survival_bp: 8_715,
      applied_survival_bp: 9_715,
      roll_bp: 1_000,
    } as RoadToGoalEventRow;
    (roadToGoalRepo.getEventByRequestNonce as Mock).mockResolvedValue(event);

    const result = await roadToGoalService.answerQuestion(
      USER_ID,
      answerInput(lockedRound, questionSet[0]!.correct_option_id)
    );

    expect(result.survived).toBe(true);
    expect(roadToGoalRepo.updateRoundState).not.toHaveBeenCalled();
  });

  it('deals and records only the next question after continue', async () => {
    lockedRound = round({
      phase: 'decision',
      cleared_zones: 1,
      state_version: 4,
      question_deadline_at: null,
      decision_deadline_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const state = await roadToGoalService.continueRound(USER_ID, {
      roundId: ROUND_ID,
      expectedVersion: 4,
      requestNonce: REQUEST_NONCE,
    });

    expect(state.phase).toBe('question');
    expect(state.question?.zone).toBe(2);
    expect(roadToGoalRepo.recordQuestionExposures).toHaveBeenCalledWith(
      dbMocks.tx,
      USER_ID,
      ROUND_ID,
      [expect.objectContaining({ question_id: questionSet[1]!.question_id })]
    );
  });

  it('cashout credits the exact fractional multiplier once', async () => {
    lockedRound = round({
      phase: 'decision',
      cleared_zones: 1,
      state_version: 7,
      question_deadline_at: null,
      decision_deadline_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const state = await roadToGoalService.cashout(USER_ID, {
      roundId: ROUND_ID,
      expectedVersion: 7,
      requestNonce: REQUEST_NONCE,
    });

    expect(state.status).toBe('cashed');
    expect(state.payout_coins).toBe(25.75);
    expect(storeRepo.adjustWalletMinorInTx).toHaveBeenCalledWith(
      dbMocks.tx,
      USER_ID,
      2_575,
      0
    );
    expect(storeRepo.insertTransactionLogInTx).toHaveBeenCalledWith(
      dbMocks.tx,
      expect.objectContaining({
        coinsDeltaMinor: 2_575,
        idempotencyKey: `road-to-goal:${ROUND_ID}:payout`,
      })
    );
    expect(roadToGoalRepo.insertLedgerKey).toHaveBeenCalledWith(
      dbMocks.tx,
      {
        idempotencyKey: `road-to-goal:${ROUND_ID}:payout`,
        roundId: ROUND_ID,
        userId: USER_ID,
        eventType: 'road_to_goal_payout',
      }
    );
  });

  it('auto-pays the four-times return after surviving zone eleven', async () => {
    lockedRound = withOutcomeSeed(true, true, {
      cleared_zones: 10,
      state_version: 10,
    });
    const question = questionSet[10]!;

    const result = await roadToGoalService.answerQuestion(
      USER_ID,
      answerInput(lockedRound, question.correct_option_id)
    );

    expect(result.state.status).toBe('completed');
    expect(result.state.payout_coins).toBe(100);
    expect(storeRepo.adjustWalletMinorInTx).toHaveBeenCalledWith(
      dbMocks.tx,
      USER_ID,
      10_000,
      0
    );
  });

  it('auto-cashes an expired decision at the last safe multiplier', async () => {
    lockedRound = round({
      phase: 'decision',
      cleared_zones: 2,
      state_version: 2,
      question_deadline_at: null,
      decision_deadline_at: new Date(Date.now() - 1).toISOString(),
    });
    (roadToGoalRepo.getNextExpiredRoundForUpdateSkipLocked as Mock)
      .mockResolvedValueOnce(lockedRound)
      .mockResolvedValue(null);

    await expect(roadToGoalService.sweepStaleRounds()).resolves.toEqual({ settled: 1 });

    expect(storeRepo.adjustWalletMinorInTx).toHaveBeenCalledWith(
      dbMocks.tx,
      USER_ID,
      2_700,
      0
    );
    expect(roadToGoalRepo.insertEvent).toHaveBeenCalledWith(
      dbMocks.tx,
      expect.objectContaining({ eventType: 'auto_cashout' })
    );
  });

  it('skips a persistently invalid expired row and settles later liabilities', async () => {
    const invalid = round({
      id: '99999999-9999-4999-8999-999999999999',
      phase: 'decision',
      cleared_zones: 1,
      question_deadline_at: null,
      decision_deadline_at: new Date(Date.now() - 1).toISOString(),
      rules_manifest_hash: '00'.repeat(32),
    });
    lockedRound = round({
      phase: 'decision',
      cleared_zones: 2,
      state_version: 2,
      question_deadline_at: null,
      decision_deadline_at: new Date(Date.now() - 1).toISOString(),
    });
    (roadToGoalRepo.getNextExpiredRoundForUpdateSkipLocked as Mock)
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce(lockedRound)
      .mockResolvedValue(null);

    await expect(roadToGoalService.sweepStaleRounds()).resolves.toEqual({ settled: 1 });

    expect(roadToGoalRepo.getNextExpiredRoundForUpdateSkipLocked).toHaveBeenNthCalledWith(
      2,
      dbMocks.tx,
      [invalid.id]
    );
    expect(storeRepo.adjustWalletMinorInTx).toHaveBeenCalledWith(
      dbMocks.tx,
      USER_ID,
      2_700,
      0
    );
  });

  it('reveals a complete proof only after settlement', async () => {
    lockedRound = round({
      status: 'lost',
      phase: 'settled',
      question_deadline_at: null,
      settled_at: new Date().toISOString(),
      settlement_reason: 'tackle',
    });
    (roadToGoalRepo.getProofEvents as Mock).mockResolvedValue([{
      zone: 1,
      event_type: 'answer',
      question_id: questionSet[0]!.question_id,
      answer_option: questionSet[0]!.options.find(
        (option) => option.id !== questionSet[0]!.correct_option_id
      )!.id,
      correct_option: questionSet[0]!.correct_option_id,
      answer_correct: false,
      expected_accuracy_bp: 8_000,
      target_survival_bp: 9_515,
      correct_survival_bp: 9_715,
      wrong_survival_bp: 8_715,
      applied_survival_bp: 8_715,
      roll_bp: 9_000,
      survived: false,
    }]);

    const proof = await roadToGoalService.getProof(USER_ID, ROUND_ID);

    expect(proof.server_seed).toBe(DEFAULT_SEED);
    expect(proof.commit_hash).toBe(roadToGoalServerSeedCommitment({
      serverSeed: DEFAULT_SEED,
      roundId: ROUND_ID,
      calibrationVersionId: CALIBRATION_ID,
      rulesManifestHash: RULES_HASH,
      questionSetHash: QUESTION_SET_HASH,
      stakeCoins: 25,
      autoCashoutZone: null,
    }));
    expect(proof.question_set_hash).toBe(QUESTION_SET_HASH);
    expect(proof.question_hashes).toHaveLength(11);
    expect(proof.question_set).toHaveLength(1);
    expect(proof.zones).toEqual([
      expect.objectContaining({ zone: 1, outcome: 'wrong', survived: false, roll_bp: 9_000 }),
    ]);
  });

  it('rejects stale optimistic state before mutating', async () => {
    lockedRound = round({ state_version: 3 });

    await expect(roadToGoalService.answerQuestion(USER_ID, {
      ...answerInput(lockedRound, questionSet[0]!.correct_option_id),
      expectedVersion: 2,
    })).rejects.toThrow('Stale state');
    expect(roadToGoalRepo.updateRoundState).not.toHaveBeenCalled();
  });

  it('rejects a round snapshot changed after the pre-seed commitment', async () => {
    lockedRound = round({
      run_questions: questionSet.map((question, index) => (
        index === 0
          ? {
              ...question,
              correct_option_id: question.options.find(
                (option) => option.id !== question.correct_option_id
              )!.id,
            }
          : question
      )) as never,
    });

    await expect(roadToGoalService.getRoundState(USER_ID, ROUND_ID))
      .rejects.toThrow('round question commitment is invalid');
  });
});
