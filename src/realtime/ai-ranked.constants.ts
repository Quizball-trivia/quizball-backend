export const RANKED_AI_CORRECTNESS = 0.65;

const AI_NAME_PREFIXES = [
  'cr',
  'messi',
  'ron',
  'fut',
  'goal',
  'striker',
  'legend',
  'ultra',
  'dribble',
  'pitch',
];

// Keep this in sync with frontend-web-next/src/lib/avatars.ts.
const AI_AVATAR_SEEDS = [
  'striker',
  'goalkeeper',
  'defender',
  'midfielder',
  'captain',
  'coach',
  'ronaldo',
  'messi',
  'neymar',
  'mbappe',
  'haaland',
  'benzema',
  'liverpool',
  'barcelona',
  'madrid',
  'bayern',
  'arsenal',
  'chelsea',
  'legend',
  'rookie',
  'veteran',
  'champion',
  'winner',
  'pro',
];

const AI_AVATAR_BG = 'b6e3f4,c0aede,d1d4f9';

function randomFrom<T>(values: T[]): T {
  return values[Math.floor(Math.random() * values.length)] as T;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export function generateRankedAiUsername(): string {
  const prefix = randomFrom(AI_NAME_PREFIXES);
  const suffix = Math.floor(Math.random() * 90000) + 10000;
  return `${prefix}${suffix}`;
}

export function generateRankedAiAvatarUrl(size = 96): string {
  const seed = randomFrom(AI_AVATAR_SEEDS);
  return `https://api.dicebear.com/7.x/big-smile/svg?seed=${encodeSegment(seed)}&backgroundColor=${encodeSegment(AI_AVATAR_BG)}&size=${size}`;
}

export function generateRankedAiProfile(): { username: string; avatarUrl: string } {
  return {
    username: generateRankedAiUsername(),
    avatarUrl: generateRankedAiAvatarUrl(96),
  };
}

export function rankedAiLobbyKey(lobbyId: string): string {
  return `ranked:ai:lobby:${lobbyId}`;
}

export function rankedAiMatchKey(matchId: string): string {
  return `ranked:ai:match:${matchId}`;
}
