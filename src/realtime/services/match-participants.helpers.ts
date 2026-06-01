import { logger } from '../../core/logger.js';
import { countryPayload } from '../../core/country.js';
import { categoriesRepo } from '../../modules/categories/categories.repo.js';
import { matchPlayersRepo } from '../../modules/matches/match-players.repo.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { registerAiUserId, identifyUser } from '../../core/analytics.js';
import { parseStoredAvatarCustomization, type AvatarCustomization } from '../../modules/users/avatar-customization.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import type { RankedLobbyContext } from '../../modules/lobbies/lobbies.types.js';
import { getMatchCacheOrRebuild, type MatchCache } from '../match-cache.js';
import { getCurrentCountriesForUsers, getCurrentCountryForUser } from '../session-country.js';

export type MatchParticipantSnapshot = {
  user_id: string;
  seat: number;
  total_points: number;
  correct_answers: number;
  goals: number;
  penalty_goals: number;
  avg_time_ms: number | null;
};

export async function resolveMatchCategoryName(
  categoryId: string | null | undefined
): Promise<Record<string, string> | undefined> {
  if (!categoryId) return undefined;
  try {
    const category = await categoriesRepo.getById(categoryId);
    const raw = category?.name;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    return raw as Record<string, string>;
  } catch (err) {
    logger.warn({ err, categoryId }, 'Failed to resolve category name (non-fatal)');
    return undefined;
  }
}

export async function getOpponentInfo(matchId: string, userId: string): Promise<{
  id: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: AvatarCustomization | null;
  favoriteClub: string | null;
  country?: string;
  countryCode?: string;
}> {
  const players = await matchPlayersRepo.listMatchPlayers(matchId);
  const opponent = players.find((player) => player.user_id !== userId);
  if (!opponent) {
    return {
      id: 'opponent',
      username: 'Opponent',
      avatarUrl: null,
      avatarCustomization: null,
      favoriteClub: null,
    };
  }

  const opponentUser = await usersRepo.getById(opponent.user_id);
  const currentCountry = await getCurrentCountryForUser(opponent.user_id);
  return {
    id: opponent.user_id,
    username: opponentUser?.nickname ?? 'Player',
    avatarUrl: opponentUser?.avatar_url ?? null,
    avatarCustomization: parseStoredAvatarCustomization(opponentUser?.avatar_customization),
    favoriteClub: opponentUser?.favorite_club ?? null,
    ...countryPayload(currentCountry ?? opponentUser?.country),
  };
}

export function participantSnapshotFromCache(cache: MatchCache): MatchParticipantSnapshot[] {
  return cache.players.map((player) => ({
    user_id: player.userId,
    seat: player.seat,
    total_points: player.totalPoints,
    correct_answers: player.correctAnswers,
    goals: player.goals,
    penalty_goals: player.penaltyGoals,
    avg_time_ms: player.avgTimeMs,
  }));
}

export function participantSnapshotFromRows(rows: Array<{
  user_id: string;
  seat: number;
  total_points: number;
  correct_answers: number;
  goals: number;
  penalty_goals: number;
  avg_time_ms: number | null;
}>): MatchParticipantSnapshot[] {
  return rows.map((row) => ({
    user_id: row.user_id,
    seat: row.seat,
    total_points: row.total_points,
    correct_answers: row.correct_answers,
    goals: row.goals,
    penalty_goals: row.penalty_goals,
    avg_time_ms: row.avg_time_ms,
  }));
}

export async function getParticipantSnapshot(matchId: string): Promise<{
  participants: MatchParticipantSnapshot[];
  cache: MatchCache | null;
}> {
  const cache = await getMatchCacheOrRebuild(matchId);
  if (cache && cache.players.length > 0) {
    return {
      participants: participantSnapshotFromCache(cache),
      cache,
    };
  }

  const players = await matchPlayersRepo.listMatchPlayers(matchId);
  return {
    participants: participantSnapshotFromRows(players),
    cache: null,
  };
}

export async function getOpponentInfoFromParticipants(
  participants: MatchParticipantSnapshot[],
  userId: string,
  matchMode?: 'friendly' | 'ranked',
  rankedContext?: RankedLobbyContext | null
): Promise<{
  id: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: AvatarCustomization | null;
  rp?: number;
  country?: string;
  countryCode?: string;
}> {
  const opponent = participants.find((player) => player.user_id !== userId);
  if (!opponent) {
    return {
      id: 'opponent',
      username: 'Opponent',
      avatarUrl: null,
      avatarCustomization: null,
    };
  }

  const opponentUser = await usersRepo.getById(opponent.user_id);
  const currentCountry = await getCurrentCountryForUser(opponent.user_id);
  let rp: number | undefined;
  if (matchMode === 'ranked') {
    if (opponentUser?.is_ai && typeof rankedContext?.aiAnchorRp === 'number') {
      rp = rankedContext.aiAnchorRp;
    } else {
      const profile = await rankedService.ensureProfile(opponent.user_id);
      rp = profile.rp;
    }
  }
  return {
    id: opponent.user_id,
    username: opponentUser?.nickname ?? 'Player',
    avatarUrl: opponentUser?.avatar_url ?? null,
    avatarCustomization: parseStoredAvatarCustomization(opponentUser?.avatar_customization),
    ...(rp != null ? { rp } : {}),
    ...countryPayload(currentCountry ?? opponentUser?.country),
  };
}

export async function buildParticipantPayloads(
  players: MatchParticipantSnapshot[],
  matchMode: 'friendly' | 'ranked',
  rankedContext?: RankedLobbyContext | null
): Promise<Array<{
  userId: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: AvatarCustomization | null;
  seat: number;
  rankPoints?: number;
  country?: string;
  countryCode?: string;
}>> {
  const usersById = await usersRepo.getByIds(players.map((player) => player.user_id));
  // Safety net: re-register AI ids so analytics still skips them after a server
  // restart clears the in-memory set built at AI-user creation time. Real users
  // are identified so their server-side events carry a name/email and merge with
  // the web-SDK person (same Supabase id as distinctId) instead of showing as a
  // bare anonymous UUID.
  for (const user of usersById.values()) {
    if (!user) continue;
    if (user.is_ai) {
      registerAiUserId(user.id);
    } else {
      identifyUser(user.id, {
        email: user.email ?? undefined,
        nickname: user.nickname ?? undefined,
        country: user.country ?? undefined,
        favorite_club: user.favorite_club ?? undefined,
        preferred_language: user.preferred_language ?? undefined,
      });
    }
  }
  const currentCountriesByUserId = await getCurrentCountriesForUsers(players.map((player) => player.user_id));
  let rpByUserId = new Map<string, number>();

  if (matchMode === 'ranked') {
    const nonAiPlayers = players.filter((player) => {
      const user = usersById.get(player.user_id);
      return !(user?.is_ai && typeof rankedContext?.aiAnchorRp === 'number');
    });
    const profiles = await Promise.all(
      nonAiPlayers.map(async (player) => ({
        userId: player.user_id,
        profile: await rankedService.ensureProfile(player.user_id),
      }))
    );
    rpByUserId = new Map(profiles.map((entry) => [entry.userId, entry.profile.rp]));
  }

  return players.map((player) => {
    const user = usersById.get(player.user_id);
    const rankPoints = matchMode === 'ranked' && user?.is_ai && typeof rankedContext?.aiAnchorRp === 'number'
      ? rankedContext.aiAnchorRp
      : rpByUserId.get(player.user_id);

    return {
      userId: player.user_id,
      username: user?.nickname ?? 'Player',
      avatarUrl: user?.avatar_url ?? null,
      avatarCustomization: parseStoredAvatarCustomization(user?.avatar_customization),
      seat: player.seat,
      ...(rankPoints != null ? { rankPoints } : {}),
      ...countryPayload(currentCountriesByUserId.get(player.user_id) ?? user?.country),
    };
  });
}
