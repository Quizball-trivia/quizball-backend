import type { QuizballServer } from './socket-server.js';
import type { RoomGameId } from '../modules/room/room.types.js';

/**
 * Room games that a tab must declare (handshake `auth.games`) before it is sent anything about them: an older bundle
 * cannot draw them (its lobby screen dereferences labels of the games it knows). Games every deployed bundle can draw
 * are not listed. A tab that does not declare a gated game sits in its `caps:no-<game>` room, and every lobby or match
 * broadcast of that game skips that room: one adapter broadcast, the same on every replica.
 */
export const GATED_ROOM_GAMES: readonly RoomGameId[] = ['tenable', 'football_race'];

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
}

/** The broadcast target for these rooms, minus the tabs that cannot draw `game`. */
export function toCapable(io: QuizballServer, rooms: string | string[], game: string | null | undefined): ReturnType<QuizballServer['to']> {
  const target = io.to(rooms);
  return isGated(game) ? target.except(legacyRoom(game)) : target;
}

/**
 * Every member user who is online has at least one tab that declares `game`. Offline members pass (they are checked
 * when they come back); a lookup that fails refuses. Relaxed on purpose: one stale tab of a member must not block the
 * room; that tab simply stops receiving the room's updates.
 */
export async function membersCanDraw(io: QuizballServer, userIds: readonly string[], game: string | null | undefined): Promise<boolean> {
  if (!isGated(game)) return true;
  try {
    for (const userId of userIds) {
      const sockets = await io.in(`user:${userId}`).fetchSockets();
      if (sockets.length > 0 && !sockets.some((s) => declares(s.data, game))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The refusal an older tab gets. A code older bundles have no copy for, so they show this message as it is (a mapped code
 * such as CAPABILITY_REQUIRED would read "sign up" to them); newer bundles show their own translation.
 */
export const NEEDS_RELOAD_CODE = 'GAME_NEEDS_RELOAD';
export const NEEDS_RELOAD_MESSAGE = 'This room plays a newer game: reload the page to join it';
export const MEMBERS_NEED_RELOAD_MESSAGE = 'Everyone in the room needs to reload the page to play this game';
