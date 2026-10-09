import type { z } from 'zod';
import type { RoomPoolItem } from './room.repo.js';
import type { RoomGameId, RoomLocale } from './room.types.js';

export type RoomSeatStatus = 'in' | 'away' | 'withdrawn';
export type RoomSeatChange = { seat: number; change: 'away' | 'back' | 'leave' };

/** What the runtime reads from any game's state: its next deadline (ms epoch) and each seat's presence. */
export interface RoomEngineState {
  deadline: number;
  status: RoomSeatStatus[];
}

export interface RoomEngineStanding { seat: number; points: number; roundWins: number; place: number }

/**
 * A room game's rules, pure: no I/O, time comes in as `nowMs` (the database clock read under the match lock). The
 * runtime owns the ready gate, presence and absence windows, idempotency, the phase token and the lifecycle; the
 * engine owns the game. `tick`, `afterOutage` and `seatsChanged` return the state they were given when nothing changes.
 */
/** Items per difficulty from the game's pool, of one tag when given. */
export type RoomPoolPick = (wanted: Record<string, number>, tag?: string) => Promise<RoomPoolItem[]>;

export interface RoomEngine<Content, State extends RoomEngineState, Command, Options = null> {
  game: RoomGameId;
  version: number;
  commandSchema: z.ZodType<Command>;
  /** Validates a stored pack; null when it is not this engine's content. */
  parseContent(raw: unknown): Content | null;
  /** Validates a room's options (what the host chose: which clubs, how hard); undefined when they are not this game's. */
  parseOptions(raw: unknown): Options | undefined;
  /** Picks a match's content from the private pool; null when the pool cannot fill a pack. */
  deal(pick: RoomPoolPick, options: Options): Promise<{ itemIds: string[]; content: unknown } | null>;
  /**
   * Attaches what the rules need besides the stored pack (the footballers of its release). In memory only; called on
   * every load, so it must be cheap once warm. Throws when it cannot: the match then waits for the next attempt.
   */
  hydrate?(content: Content): Promise<Content>;
  start(seats: number, content: Content, nowMs: number): State;
  /** Moves the game's own clock up to `nowMs`, one boundary per call. */
  tick(state: State, content: Content, nowMs: number): State;
  /** The server was not running when a deadline passed: an open phase gets a fresh window, nobody is charged. */
  afterOutage(state: State, content: Content, nowMs: number): State;
  /** `nowMs`: when the changes happened (an absence deadline settled in order, or the database clock for a live change). */
  seatsChanged(state: State, changes: readonly RoomSeatChange[], nowMs: number): State;
  apply(state: State, content: Content, seat: number, command: Command, nowMs: number): { state: State; error?: string };
  terminal(state: State): 'completed' | 'cancelled' | null;
  standings(state: State): RoomEngineStanding[];
  /** What `seat` sees. Never something the game has not revealed. */
  view(state: State, content: Content, seat: number, locale: RoomLocale): unknown;
  /**
   * For a "that was right" report: what a text refused in `round` was about. Null when the game would accept it
   * there, or the round's answers are not out yet (a report must never work as a way to test answers).
   */
  refusal?(state: State, content: Content, round: number, text: string): RoomRefusal | null;
}

export interface RoomRefusal { release: string; subject: string | null; resolvedPid: string | null }

export type AnyRoomEngine = RoomEngine<unknown, RoomEngineState, unknown, unknown>;
