import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const getByIdMock = vi.fn();
const listFriendsMock = vi.fn();
const listIncomingRequestsMock = vi.fn();
const listOutgoingRequestsMock = vi.fn();
const friendshipExistsMock = vi.fn();
const getPendingRequestBetweenMock = vi.fn();
const createFriendRequestMock = vi.fn();
const acceptRequestMock = vi.fn();
const declineRequestMock = vi.fn();
const cancelRequestMock = vi.fn();
const removeFriendMock = vi.fn();

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getById: (...args: unknown[]) => getByIdMock(...args),
  },
}));

vi.mock('../../src/modules/friends/friends.repo.js', () => ({
  friendsRepo: {
    listFriends: (...args: unknown[]) => listFriendsMock(...args),
    listIncomingRequests: (...args: unknown[]) => listIncomingRequestsMock(...args),
    listOutgoingRequests: (...args: unknown[]) => listOutgoingRequestsMock(...args),
    friendshipExists: (...args: unknown[]) => friendshipExistsMock(...args),
    getPendingRequestBetween: (...args: unknown[]) => getPendingRequestBetweenMock(...args),
    createFriendRequest: (...args: unknown[]) => createFriendRequestMock(...args),
    acceptRequest: (...args: unknown[]) => acceptRequestMock(...args),
    declineRequest: (...args: unknown[]) => declineRequestMock(...args),
    cancelRequest: (...args: unknown[]) => cancelRequestMock(...args),
    removeFriend: (...args: unknown[]) => removeFriendMock(...args),
  },
}));

describe('friendsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a pending request for an existing non-friend user', async () => {
    getByIdMock.mockResolvedValue({ id: 'target-user-id' });
    friendshipExistsMock.mockResolvedValue(false);
    getPendingRequestBetweenMock.mockResolvedValue(null);
    createFriendRequestMock.mockResolvedValue({ id: 'request-id' });

    const { friendsService } = await import('../../src/modules/friends/friends.service.js');

    await expect(friendsService.createRequest('sender-id', 'target-user-id')).resolves.toEqual({
      requestId: 'request-id',
      status: 'pending',
    });
    expect(createFriendRequestMock).toHaveBeenCalledWith('sender-id', 'target-user-id');
  });

  it('rejects self-requests', async () => {
    const { friendsService } = await import('../../src/modules/friends/friends.service.js');

    await expect(friendsService.createRequest('same-id', 'same-id')).rejects.toThrow(
      'You cannot send a friend request to yourself'
    );
    expect(createFriendRequestMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate pending requests from the same sender', async () => {
    getByIdMock.mockResolvedValue({ id: 'target-user-id' });
    friendshipExistsMock.mockResolvedValue(false);
    getPendingRequestBetweenMock.mockResolvedValue({
      id: 'request-id',
      sender_user_id: 'sender-id',
      receiver_user_id: 'target-user-id',
      status: 'pending',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    });

    const { friendsService } = await import('../../src/modules/friends/friends.service.js');

    await expect(friendsService.createRequest('sender-id', 'target-user-id')).rejects.toThrow(
      'Friend request already sent'
    );
    expect(createFriendRequestMock).not.toHaveBeenCalled();
  });

  it('rejects when a reverse pending request already exists', async () => {
    getByIdMock.mockResolvedValue({ id: 'target-user-id' });
    friendshipExistsMock.mockResolvedValue(false);
    getPendingRequestBetweenMock.mockResolvedValue({
      id: 'request-id',
      sender_user_id: 'target-user-id',
      receiver_user_id: 'sender-id',
      status: 'pending',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    });

    const { friendsService } = await import('../../src/modules/friends/friends.service.js');

    await expect(friendsService.createRequest('sender-id', 'target-user-id')).rejects.toThrow(
      'This user has already sent you a friend request'
    );
    expect(createFriendRequestMock).not.toHaveBeenCalled();
  });

  it('accepts and declines only existing pending requests', async () => {
    acceptRequestMock.mockResolvedValue(true);
    declineRequestMock.mockResolvedValue(true);
    const { friendsService } = await import('../../src/modules/friends/friends.service.js');

    await expect(friendsService.acceptRequest('receiver-id', 'request-id')).resolves.toEqual({
      success: true,
    });
    await expect(friendsService.declineRequest('receiver-id', 'request-id')).resolves.toEqual({
      success: true,
    });
  });

  it('throws when accepting a missing request', async () => {
    acceptRequestMock.mockResolvedValue(false);
    const { friendsService } = await import('../../src/modules/friends/friends.service.js');

    await expect(friendsService.acceptRequest('receiver-id', 'missing-request')).rejects.toThrow(
      'Friend request not found'
    );
  });

  it('removes an existing friend', async () => {
    removeFriendMock.mockResolvedValue(true);
    const { friendsService } = await import('../../src/modules/friends/friends.service.js');

    await expect(friendsService.removeFriend('user-a', 'user-b')).resolves.toEqual({
      success: true,
    });
    expect(removeFriendMock).toHaveBeenCalledWith('user-a', 'user-b');
  });

  it('rejects when trying to remove yourself', async () => {
    const { friendsService } = await import('../../src/modules/friends/friends.service.js');

    await expect(friendsService.removeFriend('same-id', 'same-id')).rejects.toThrow(
      'You cannot remove yourself'
    );
    expect(removeFriendMock).not.toHaveBeenCalled();
  });

  it('throws when friendship does not exist', async () => {
    removeFriendMock.mockResolvedValue(false);
    const { friendsService } = await import('../../src/modules/friends/friends.service.js');

    await expect(friendsService.removeFriend('user-a', 'user-b')).rejects.toThrow(
      'Friendship not found'
    );
    expect(removeFriendMock).toHaveBeenCalledWith('user-a', 'user-b');
  });

  it('cancels a pending sent request', async () => {
    cancelRequestMock.mockResolvedValue(true);
    const { friendsService } = await import('../../src/modules/friends/friends.service.js');

    await expect(friendsService.cancelRequest('sender-id', 'request-id')).resolves.toEqual({
      success: true,
    });
    expect(cancelRequestMock).toHaveBeenCalledWith('request-id', 'sender-id');
  });

  it('throws when cancelling a request that does not exist or is not owned by sender', async () => {
    cancelRequestMock.mockResolvedValue(false);
    const { friendsService } = await import('../../src/modules/friends/friends.service.js');

    await expect(friendsService.cancelRequest('sender-id', 'missing-request')).rejects.toThrow(
      'Friend request not found'
    );
  });
});
