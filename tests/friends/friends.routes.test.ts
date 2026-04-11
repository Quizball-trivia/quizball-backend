import 'express-async-errors';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

import '../setup.js';
import { requestIdMiddleware, errorHandler } from '../../src/http/middleware/index.js';
import { friendsRoutes } from '../../src/http/routes/friends.routes.js';
import { BadRequestError, NotFoundError } from '../../src/core/errors.js';

vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, _res, next) => {
    req.user = { id: 'viewer-id', role: 'user' };
    req.identity = { provider: 'test', subject: 'viewer-subject' };
    next();
  }),
}));

vi.mock('../../src/modules/friends/friends.service.js', () => ({
  friendsService: {
    listFriends: vi.fn(),
    listRequests: vi.fn(),
    createRequest: vi.fn(),
    acceptRequest: vi.fn(),
    declineRequest: vi.fn(),
    cancelRequest: vi.fn(),
    removeFriend: vi.fn(),
  },
}));

import { friendsService } from '../../src/modules/friends/friends.service.js';

describe('friendsRoutes', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/friends', friendsRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/v1/friends returns the list', async () => {
    (friendsService.listFriends as Mock).mockResolvedValue({ friends: [] });

    const response = await request(app).get('/api/v1/friends');

    expect(response.status).toBe(200);
    expect(friendsService.listFriends).toHaveBeenCalledWith('viewer-id');
  });

  it('POST /api/v1/friends/requests validates body', async () => {
    const response = await request(app)
      .post('/api/v1/friends/requests')
      .send({ targetUserId: 'not-a-uuid' });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/v1/friends/requests creates a request', async () => {
    (friendsService.createRequest as Mock).mockResolvedValue({
      requestId: '11111111-1111-1111-1111-111111111111',
      status: 'pending',
    });

    const response = await request(app)
      .post('/api/v1/friends/requests')
      .send({ targetUserId: '22222222-2222-2222-2222-222222222222' });

    expect(response.status).toBe(201);
    expect(friendsService.createRequest).toHaveBeenCalledWith(
      'viewer-id',
      '22222222-2222-2222-2222-222222222222'
    );
  });

  it('GET /api/v1/friends/requests returns requests', async () => {
    (friendsService.listRequests as Mock).mockResolvedValue({
      incoming: [],
      outgoing: [],
      incomingCount: 0,
    });

    const response = await request(app).get('/api/v1/friends/requests');

    expect(response.status).toBe(200);
    expect(friendsService.listRequests).toHaveBeenCalledWith('viewer-id');
  });

  it('POST /api/v1/friends/requests/:requestId/accept accepts a request', async () => {
    (friendsService.acceptRequest as Mock).mockResolvedValue({ success: true });

    const response = await request(app)
      .post('/api/v1/friends/requests/44444444-4444-4444-4444-444444444444/accept');

    expect(response.status).toBe(200);
    expect(friendsService.acceptRequest).toHaveBeenCalledWith(
      'viewer-id',
      '44444444-4444-4444-4444-444444444444'
    );
  });

  it('POST /api/v1/friends/requests/:requestId/decline declines a request', async () => {
    (friendsService.declineRequest as Mock).mockResolvedValue({ success: true });

    const response = await request(app)
      .post('/api/v1/friends/requests/55555555-5555-5555-5555-555555555555/decline');

    expect(response.status).toBe(200);
    expect(friendsService.declineRequest).toHaveBeenCalledWith(
      'viewer-id',
      '55555555-5555-5555-5555-555555555555'
    );
  });

  it('POST /api/v1/friends/requests/:requestId/accept validates params', async () => {
    const response = await request(app)
      .post('/api/v1/friends/requests/not-a-uuid/accept');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('DELETE /api/v1/friends/:friendUserId validates params', async () => {
    const response = await request(app)
      .delete('/api/v1/friends/not-a-uuid');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(friendsService.removeFriend).not.toHaveBeenCalled();
  });

  it('DELETE /api/v1/friends/:friendUserId removes a friend', async () => {
    (friendsService.removeFriend as Mock).mockResolvedValue({ success: true });

    const response = await request(app)
      .delete('/api/v1/friends/33333333-3333-3333-3333-333333333333');

    expect(response.status).toBe(200);
    expect(friendsService.removeFriend).toHaveBeenCalledWith(
      'viewer-id',
      '33333333-3333-3333-3333-333333333333'
    );
  });

  it('DELETE /api/v1/friends/:friendUserId returns 404 when friendship not found', async () => {
    (friendsService.removeFriend as Mock).mockRejectedValue(
      new NotFoundError('Friendship not found')
    );

    const response = await request(app)
      .delete('/api/v1/friends/33333333-3333-3333-3333-333333333333');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
    expect(friendsService.removeFriend).toHaveBeenCalledWith(
      'viewer-id',
      '33333333-3333-3333-3333-333333333333'
    );
  });

  it('DELETE /api/v1/friends/:friendUserId returns 400 when trying to remove yourself', async () => {
    (friendsService.removeFriend as Mock).mockRejectedValue(
      new BadRequestError('You cannot remove yourself')
    );

    const response = await request(app)
      .delete('/api/v1/friends/22222222-2222-2222-2222-222222222222');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('BAD_REQUEST');
    expect(friendsService.removeFriend).toHaveBeenCalled();
  });

  it('POST /api/v1/friends/requests/:requestId/cancel cancels a sent request', async () => {
    (friendsService.cancelRequest as Mock).mockResolvedValue({ success: true });

    const response = await request(app)
      .post('/api/v1/friends/requests/66666666-6666-6666-6666-666666666666/cancel');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(friendsService.cancelRequest).toHaveBeenCalledWith(
      'viewer-id',
      '66666666-6666-6666-6666-666666666666'
    );
  });

  it('POST /api/v1/friends/requests/:requestId/cancel returns 404 when request not found', async () => {
    (friendsService.cancelRequest as Mock).mockRejectedValue(
      new NotFoundError('Friend request not found')
    );

    const response = await request(app)
      .post('/api/v1/friends/requests/77777777-7777-7777-7777-777777777777/cancel');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('POST /api/v1/friends/requests/:requestId/cancel validates params', async () => {
    const response = await request(app)
      .post('/api/v1/friends/requests/not-a-uuid/cancel');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(friendsService.cancelRequest).not.toHaveBeenCalled();
  });
});
