import type { QuizballServer } from './socket-server.js';
import { CLIENT_VERSION_TOKENS, clientVersionToken } from '../modules/room/room.registry.js';
import type { RoomGameId } from '../modules/room/room.types.js';

/**
 * Room games that a tab must declare (handshake `auth.games`) before it is sent anything about them: an older bundle
 * cannot draw them (its lobby screen dereferences labels of the games it knows). Games every deployed bundle can draw
 * are not listed. A tab that does not declare a gated game sits in its `caps:no-<game>` room, and every lobby or match
 * broadcast of that game skips that room: one adapter broadcast, the same on every replica.
 */
export const GATED_ROOM_GAMES: readonly RoomGameId[] = ['tenable', 'football_race', 'codenames', 'dato_falso'];

const MAX_DECLARED = 16;
export const legacyRoom = (game: string) => `caps:no-${game}`;
export const isGated = (game: string | null | undefined): game is RoomGameId => !!game && (GATED_ROOM_GAMES as readonly string[]).includes(game);

/** The handshake's declaration, cleaned: short strings only, a bounded list. */
export function declaredGames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((g): g is string => typeof g === 'string' && g.length > 0 && g.length <= 32))].slice(0, MAX_DECLARED);
}

/** True when the socket may be told about `game` (always, for a game that is not gated). */
export const declares = (data: { games?: readonly string[] } | undefined, game: string | null | undefined): boolean =>
  !isGated(game) || (data?.games ?? []).includes(game);

/** On connect, next to the user room: the legacy rooms of every gated game this tab did not declare. */
export function joinLegacyRooms(socket: { data: { games?: readonly string[] }; join: (room: string) => void }): void {
  for (const game of GATED_ROOM_GAMES) if (!declares(socket.data, game)) socket.join(legacyRoom(game));
  // The same for a newer version of a game (Codenames word boards): `caps:no-codenames@2`.
  for (const token of CLIENT_VERSION_TOKENS) if (!(socket.data.games ?? []).includes(token)) socket.join(legacyRoom(token));
}

/** The broadcast target for these rooms, minus the tabs that cannot draw `game` (at `version`, for a match). */
export function toCapable(io: QuizballServer, rooms: string | string[], game: string | null | undefined, version?: number | null): ReturnType<QuizballServer['to']> {
  let target = io.to(rooms);
  if (isGated(game)) target = target.except(legacyRoom(game));
  const token = clientVersionToken(game, version);
  return token ? target.except(legacyRoom(token)) : target;
}

/** The tab can draw this match: its game, and its version when an older bundle of the game cannot. */
export const declaresMatch = (data: { games?: readonly string[] } | undefined, match: { game: string | null | undefined; engine_version?: number | null } | null | undefined): boolean => {
  if (!match) return false;
  const token = clientVersionToken(match.game, match.engine_version);
  return declares(data, match.game) && (!token || (data?.games ?? []).includes(token));
};

/**
 * Every member user who is online has at least one tab that declares `game`. Offline members pass (they are checked
 * when they come back); a lookup that fails refuses. Relaxed on purpose: one stale tab of a member must not block the
 * room; that tab simply stops receiving the room's updates.
 */
export async function membersCanDraw(io: QuizballServer, userIds: readonly string[], game: string | null | undefined, token?: string): Promise<boolean> {
  if (!isGated(game) && !token) return true;
  const can = (data: { games?: readonly string[] }) => declares(data, game) && (!token || (data.games ?? []).includes(token));
  try {
    for (const userId of userIds) {
      const sockets = await io.in(`user:${userId}`).fetchSockets();
      if (sockets.length > 0 && !sockets.some((s) => can(s.data))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** A Codenames word board: an older Codenames bundle draws picture cards only (see the room registry's `codenames@2`). */
export const CODENAMES_WORDS_TOKEN = clientVersionToken('codenames', 2)!;
export const isCodenamesWords = (lobby: { room_game?: string | null; room_options?: unknown }): boolean =>
  lobby.room_game === 'codenames' && (lobby.room_options as { board?: unknown } | null | undefined)?.board === 'words';
/** The tab can draw the room's options (only a word board asks more than the game itself). */
export const declaresRoomOptions = (data: { games?: readonly string[] } | undefined, lobby: { room_game?: string | null; room_options?: unknown }): boolean =>
  !isCodenamesWords(lobby) || (data?.games ?? []).includes(CODENAMES_WORDS_TOKEN);

/** Room options as one string (keys sorted; null for none): what a Ready or Start says its screen showed. */
export const roomOptionsKey = (options: unknown): string | null =>
  options && typeof options === 'object'
    ? JSON.stringify(Object.fromEntries(Object.entries(options as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
    : null;

/**
 * The refusal an older tab gets. A code older bundles have no copy for, so they show this message as it is (a mapped code
 * such as CAPABILITY_REQUIRED would read "sign up" to them); newer bundles show their own translation.
 */
export const NEEDS_RELOAD_CODE = 'GAME_NEEDS_RELOAD';
export const NEEDS_RELOAD_MESSAGE = 'This room plays a newer game: reload the page to join it';
export const MEMBERS_NEED_RELOAD_MESSAGE = 'Everyone in the room needs to reload the page to play this game';
