import { describe, expect, it } from 'vitest';
import {
  toPublicProfileResponse,
  toUserResponse,
  userIdParamSchema,
  type PublicProfileData,
} from '../../src/modules/users/users.schemas.js';

describe('userIdParamSchema', () => {
  it('accepts a valid UUID', () => {
    const result = userIdParamSchema.safeParse({ userId: '550e8400-e29b-41d4-a716-446655440000' });
    expect(result.success).toBe(true);
  });

  it('rejects non-UUID strings', () => {
    const result = userIdParamSchema.safeParse({ userId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects missing userId', () => {
    const result = userIdParamSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('toPublicProfileResponse', () => {
  const fullProfile: PublicProfileData = {
    user: {
      id: 'user-123',
      nickname: 'TestPlayer',
      avatar_url: 'https://example.com/avatar.png',
      avatar_customization: null,
      country: 'US',
      favorite_club: 'Chelsea',
      total_xp: 250,
    },
    progression: {
      level: 3,
      totalXp: 250,
      currentLevelXp: 38,
      xpForNextLevel: 125,
      progressPct: 30,
    },
    ranked: {
      rp: 1200,
      tier: 'Captain',
      placementStatus: 'placed',
      placementPlayed: 3,
      placementRequired: 3,
      placementWins: 2,
      currentWinStreak: 5,
      lastRankedMatchAt: '2024-06-01T00:00:00.000Z',
    },
    stats: {
      overall: { gamesPlayed: 10, wins: 6, losses: 3, draws: 1, winRate: 60 },
      ranked: { gamesPlayed: 5, wins: 3, losses: 1, draws: 1, winRate: 60 },
      friendly: { gamesPlayed: 5, wins: 3, losses: 2, draws: 0, winRate: 60 },
    },
    headToHead: {
      userAId: 'viewer-1',
      userBId: 'user-123',
      winsA: 2,
      winsB: 3,
      draws: 1,
      total: 6,
      lastPlayedAt: '2024-06-01T00:00:00.000Z',
    },
    globalRank: { rank: 42, total: 500 },
    countryRank: { rank: 5, total: 50 },
  };

  it('maps all fields correctly using camelCase keys', () => {
    const result = toPublicProfileResponse(fullProfile);

    expect(result).toEqual({
      id: 'user-123',
      nickname: 'TestPlayer',
      avatarUrl: 'https://example.com/avatar.png',
      avatarCustomization: null,
      country: 'US',
      favoriteClub: 'Chelsea',
      progression: fullProfile.progression,
      ranked: {
        rp: 1200,
        tier: 'Captain',
        placementStatus: 'placed',
        placementPlayed: 3,
        placementRequired: 3,
        placementWins: 2,
        currentWinStreak: 5,
        lastRankedMatchAt: '2024-06-01T00:00:00.000Z',
      },
      stats: fullProfile.stats,
      headToHead: fullProfile.headToHead,
      globalRank: { rank: 42, total: 500 },
      countryRank: { rank: 5, total: 50 },
    });
  });

  it('excludes private fields (email, preferred_language, onboarding_complete)', () => {
    const result = toPublicProfileResponse(fullProfile);

    expect(result).not.toHaveProperty('email');
    expect(result).not.toHaveProperty('preferred_language');
    expect(result).not.toHaveProperty('onboarding_complete');
    expect(result).not.toHaveProperty('created_at');
  });

  it('handles null ranked, headToHead, and rank positions', () => {
    const profile: PublicProfileData = {
      ...fullProfile,
      ranked: null,
      headToHead: null,
      globalRank: null,
      countryRank: null,
    };
    const result = toPublicProfileResponse(profile);

    expect(result.ranked).toBeNull();
    expect(result.headToHead).toBeNull();
    expect(result.globalRank).toBeNull();
    expect(result.countryRank).toBeNull();
  });

  it('handles null user fields', () => {
    const profile: PublicProfileData = {
      ...fullProfile,
      user: {
        id: 'user-456',
        nickname: null,
        avatar_url: null,
        country: null,
        favorite_club: null,
        total_xp: 0,
      },
    };
    const result = toPublicProfileResponse(profile);

    expect(result.nickname).toBeNull();
    expect(result.avatarUrl).toBeNull();
    expect(result.country).toBeNull();
    expect(result.favoriteClub).toBeNull();
  });
});

describe('toUserResponse', () => {
  const baseUser = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    email: 'player@example.com',
    role: 'user',
    nickname: 'Player',
    country: 'US',
    avatar_url: null,
    favorite_club: null,
    preferred_language: 'en',
    onboarding_complete: false,
    total_xp: 0,
    created_at: '2024-06-01T00:00:00.000Z',
  };

  it('maps structured avatar customization', () => {
    const result = toUserResponse({
      ...baseUser,
      avatar_customization: { skin: 'skin_male_dark', jersey: 'jersey_green', hair: 'hair_boy_basic' },
    });

    expect(result.avatar_customization).toEqual({
      skin: 'skin_male_dark',
      jersey: 'jersey_green',
      hair: 'hair_boy_basic',
    });
  });

  it('normalizes invalid stored avatar customization to null instead of failing auth bootstrap', () => {
    const result = toUserResponse({
      ...baseUser,
      avatar_customization: 'null',
    });

    expect(result.avatar_customization).toBeNull();
  });
});
