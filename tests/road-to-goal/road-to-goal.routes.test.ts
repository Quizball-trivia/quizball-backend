import 'express-async-errors';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import '../setup.js';
import { errorHandler, requestIdMiddleware } from '../../src/http/middleware/index.js';

vi.mock('../../src/modules/road-to-goal/road-to-goal.service.js', () => ({
  roadToGoalService: {
    prepareCommitment: vi.fn(),
    startRound: vi.fn(),
    getCurrentState: vi.fn(),
    getRoundState: vi.fn(),
    getProof: vi.fn(),
    answerQuestion: vi.fn(),
    continueRound: vi.fn(),
    cashout: vi.fn(),
    heartbeat: vi.fn(),
  },
}));

vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, _res, next) => {
    req.user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'user' };
    req.identity = { provider: 'test', subject: 'test-subject' };
    next();
  }),
}));

import { config } from '../../src/core/config.js';
import { authMiddleware } from '../../src/http/middleware/auth.js';
import { roadToGoalRoutes } from '../../src/http/routes/road-to-goal.routes.js';
import { roadToGoalService } from '../../src/modules/road-to-goal/road-to-goal.service.js';

const ROUND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const QUESTION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NONCE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REQUEST_NONCE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CLIENT_SEED = 'route-test-seed';

describe('Road to Goal routes', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/road-to-goal', roadToGoalRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    config.ROAD_TO_GOAL_ENABLED = true;
  });

  it('returns 401 before the service when authentication fails', async () => {
    (authMiddleware as Mock).mockImplementationOnce((_req, res) => {
      res.status(401).json({ code: 'AUTHENTICATION_ERROR', message: 'Missing auth token' });
    });

    const response = await request(app).get('/api/v1/road-to-goal/rounds/current');

    expect(response.status).toBe(401);
    expect(authMiddleware).toHaveBeenCalled();
    expect(roadToGoalService.getCurrentState).not.toHaveBeenCalled();
  });

  it('prepares a validated server commitment without a player seed', async () => {
    (roadToGoalService.prepareCommitment as Mock).mockResolvedValue({ commitment_id: ROUND_ID });

    const response = await request(app)
      .post('/api/v1/road-to-goal/rounds/commitments')
      .send({ stake: 25, request_nonce: REQUEST_NONCE });

    expect(response.status).toBe(201);
    expect(roadToGoalService.prepareCommitment).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { stakeCoins: 25, requestNonce: REQUEST_NONCE, autoCashoutZone: null }
    );
  });

  it('starts a validated, idempotent run from a prepared commitment', async () => {
    (roadToGoalService.startRound as Mock).mockResolvedValue({ round_id: ROUND_ID });

    const response = await request(app)
      .post('/api/v1/road-to-goal/rounds')
      .send({ commitment_id: ROUND_ID, client_nonce: NONCE, client_seed: CLIENT_SEED });

    expect(response.status).toBe(201);
    expect(roadToGoalService.startRound).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      {
        commitmentId: ROUND_ID,
        clientNonce: NONCE,
        clientSeed: CLIENT_SEED,
      }
    );
  });

  it('rejects unsupported stakes before the service runs', async () => {
    const response = await request(app)
      .post('/api/v1/road-to-goal/rounds/commitments')
      .send({ stake: 100, request_nonce: REQUEST_NONCE });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(roadToGoalService.prepareCommitment).not.toHaveBeenCalled();
  });

  it('blocks only new rounds when the kill switch is off', async () => {
    config.ROAD_TO_GOAL_ENABLED = false;

    const startResponse = await request(app)
      .post('/api/v1/road-to-goal/rounds')
      .send({ commitment_id: ROUND_ID, client_nonce: NONCE, client_seed: CLIENT_SEED });

    expect(startResponse.status).toBe(503);
    expect(roadToGoalService.startRound).not.toHaveBeenCalled();
  });

  it('passes round, question, option, and optimistic version to answer scoring', async () => {
    (roadToGoalService.answerQuestion as Mock).mockResolvedValue({ outcome: 'correct' });

    const response = await request(app)
      .post('/api/v1/road-to-goal/rounds/answer')
      .send({
        round_id: ROUND_ID,
        question_id: QUESTION_ID,
        option_id: 'answer-a',
        expected_version: 3,
        request_nonce: REQUEST_NONCE,
      });

    expect(response.status).toBe(200);
    expect(roadToGoalService.answerQuestion).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      {
        roundId: ROUND_ID,
        questionId: QUESTION_ID,
        optionId: 'answer-a',
        expectedVersion: 3,
        requestNonce: REQUEST_NONCE,
      }
    );
  });

  it('rejects versions outside the PostgreSQL integer range', async () => {
    const response = await request(app)
      .post('/api/v1/road-to-goal/rounds/answer')
      .send({
        round_id: ROUND_ID,
        question_id: QUESTION_ID,
        option_id: 'answer-a',
        expected_version: 2_147_483_648,
        request_nonce: REQUEST_NONCE,
      });

    expect(response.status).toBe(422);
    expect(roadToGoalService.answerQuestion).not.toHaveBeenCalled();
  });

  it('validates owned-round read parameters', async () => {
    const response = await request(app).get('/api/v1/road-to-goal/rounds/not-a-uuid');

    expect(response.status).toBe(422);
    expect(roadToGoalService.getRoundState).not.toHaveBeenCalled();
  });
});
