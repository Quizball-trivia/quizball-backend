import '../../http/openapi/zod-init.js';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  answerRoadToGoalQuestionSchema,
  answerRoadToGoalResponseSchema,
  cashoutRoadToGoalRoundSchema,
  continueRoadToGoalRoundSchema,
  prepareRoadToGoalCommitmentSchema,
  roadToGoalCommitmentResponseSchema,
  roadToGoalRoundParamsSchema,
  roadToGoalProofResponseSchema,
  roadToGoalStateResponseSchema,
  startRoadToGoalRoundSchema,
} from './road-to-goal.schemas.js';

export function registerRoadToGoalOpenApi(registry: OpenAPIRegistry): void {
  const stateResponse = roadToGoalStateResponseSchema.openapi('RoadToGoalStateResponse');
  const commitmentResponse = roadToGoalCommitmentResponseSchema.openapi('RoadToGoalCommitmentResponse');
  const answerResponse = answerRoadToGoalResponseSchema.openapi('RoadToGoalAnswerResponse');
  const proofResponse = roadToGoalProofResponseSchema.openapi('RoadToGoalProofResponse');
  registry.register('RoadToGoalStateResponse', stateResponse);
  registry.register('RoadToGoalCommitmentResponse', commitmentResponse);
  registry.register('RoadToGoalAnswerResponse', answerResponse);
  registry.register('RoadToGoalProofResponse', proofResponse);

  const authenticatedErrors = {
    401: { description: 'Not authenticated', schema: errorResponseSchema },
    409: { description: 'Round state conflict', schema: errorResponseSchema },
    422: { description: 'Validation failed', schema: errorResponseSchema },
  } as const;

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/road-to-goal/rounds/commitments',
    summary: 'Commit the run before disclosing the player seed',
    description: 'The stable request nonce makes preparation idempotent. The returned commitment binds the server seed, fixed round id, stake, auto-cashout setting, calibration, rules manifest, and ordered question-set hash before the backend accepts a player seed.',
    tags: ['RoadToGoal'],
    security: [{ bearerAuth: [] }],
    body: prepareRoadToGoalCommitmentSchema,
    responses: {
      201: { description: 'Prepared server commitment', schema: commitmentResponse },
      ...authenticatedErrors,
      503: { description: 'Game disabled', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/road-to-goal/rounds',
    summary: 'Start or replay a Road to Goal round',
    description: 'Finalizes a prepared commitment after the player seed is disclosed. The client nonce makes finalization idempotent.',
    tags: ['RoadToGoal'],
    security: [{ bearerAuth: [] }],
    body: startRoadToGoalRoundSchema,
    responses: {
      201: { description: 'Round created or replayed', schema: stateResponse },
      400: { description: 'Insufficient coins', schema: errorResponseSchema },
      ...authenticatedErrors,
      503: { description: 'Game disabled or question pool unavailable', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/road-to-goal/rounds/{roundId}/proof',
    summary: 'Verify a settled Road to Goal round',
    description: 'After settlement, reveals the committed server seed, ordered question metadata, and every deterministic zone roll so the complete run can be independently verified.',
    tags: ['RoadToGoal'],
    security: [{ bearerAuth: [] }],
    pathParams: roadToGoalRoundParamsSchema,
    responses: {
      200: { description: 'Verifiable round proof', schema: proofResponse },
      401: authenticatedErrors[401],
      404: { description: 'Round not found', schema: errorResponseSchema },
      409: { description: 'Round is still active', schema: errorResponseSchema },
      422: authenticatedErrors[422],
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/road-to-goal/rounds/current',
    summary: 'Resume the active Road to Goal round',
    tags: ['RoadToGoal'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Current round state', schema: stateResponse },
      401: authenticatedErrors[401],
      404: { description: 'No active round', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/road-to-goal/rounds/{roundId}',
    summary: 'Read an owned Road to Goal round',
    tags: ['RoadToGoal'],
    security: [{ bearerAuth: [] }],
    pathParams: roadToGoalRoundParamsSchema,
    responses: {
      200: { description: 'Round state', schema: stateResponse },
      401: authenticatedErrors[401],
      404: { description: 'Round not found', schema: errorResponseSchema },
      422: authenticatedErrors[422],
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/road-to-goal/rounds/answer',
    summary: 'Answer the current Road to Goal question',
    tags: ['RoadToGoal'],
    security: [{ bearerAuth: [] }],
    body: answerRoadToGoalQuestionSchema,
    responses: {
      200: { description: 'Answer outcome and updated state', schema: answerResponse },
      400: { description: 'Option does not belong to the question', schema: errorResponseSchema },
      ...authenticatedErrors,
      404: { description: 'Round not found', schema: errorResponseSchema },
    },
  });

  for (const [action, body, summary] of [
    ['continue', continueRoadToGoalRoundSchema, 'Continue to the next zone'],
    ['cashout', cashoutRoadToGoalRoundSchema, 'Cash out the current return'],
  ] as const) {
    registerEndpoint(registry, {
      method: 'post',
      path: `/api/v1/road-to-goal/rounds/${action}`,
      summary,
      tags: ['RoadToGoal'],
      security: [{ bearerAuth: [] }],
      body,
      responses: {
        200: { description: 'Updated round state', schema: stateResponse },
        ...authenticatedErrors,
        404: { description: 'Round not found', schema: errorResponseSchema },
      },
    });
  }

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/road-to-goal/rounds/heartbeat',
    summary: 'Keep the active round session alive',
    tags: ['RoadToGoal'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Heartbeat recorded' },
      401: authenticatedErrors[401],
    },
  });
}
