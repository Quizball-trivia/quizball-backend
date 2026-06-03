/**
 * In-process Socket.IO adapter for the match harness.
 *
 * The engine emits exclusively through a small surface:
 *   io.to(room).emit(event, payload)         — match:/user:/lobby: rooms
 *   io.emit(event, payload)                  — global broadcast (rare)
 *   io.in(room).fetchSockets()               — list sockets in a room
 *   socket.emit / join / leave / data / id   — per-connection
 *
 * FakeIo records every emit into an EventTrace tagged with the target room, so
 * user-specific events (acks, rejoin-available, errors) are attributable to a
 * seat — not just match-room broadcasts. FakeSocket models one "human" seat.
 *
 * The shapes are intentionally minimal but structurally compatible with the
 * engine's usage (verified against the io/socket call sites). They are cast to
 * the engine's QuizballServer/QuizballSocket at the boundary.
 *
 * SCOPE (important for lifecycle/rejoin scenarios): this adapter is OBSERVE-ONLY
 * on the server→client direction — `io.to(room).emit` / `socket.emit` are RECORDED
 * into the trace, not delivered to any client-side handler. The bot drives the
 * match by calling the server's handler functions directly (handlePossessionAnswer,
 * handleMatchLeave/Rejoin, …) and reading the resulting trace. There is no real
 * client event loop. `FakeSocket.on`/`_deliver` exist for tests that want to
 * simulate inbound client events, but the match runner does not rely on them.
 * If a future scenario needs true round-trip client behavior, that has to be added
 * explicitly.
 */

export type TraceDir = 'server->room' | 'server->socket' | 'client->server';

export interface TraceEvent {
  /** Monotonic sequence number (ordering within the match). */
  seq: number;
  /** Faked wall-clock ms at emit time (Date.now() under fake timers). */
  t: number;
  dir: TraceDir;
  event: string;
  /** Target room for room emits, or the socket id for direct emits. */
  target?: string;
  payload: unknown;
}

export interface EventTrace {
  events: TraceEvent[];
  record(dir: TraceDir, event: string, payload: unknown, target?: string): void;
  /** All events whose name matches (optionally filtered by target room/socket). */
  byEvent(event: string, target?: string): TraceEvent[];
  last(event: string): TraceEvent | undefined;
}

export function createTrace(now: () => number): EventTrace {
  const events: TraceEvent[] = [];
  let seq = 0;
  return {
    events,
    record(dir, event, payload, target) {
      events.push({ seq: seq++, t: now(), dir, event, target, payload });
    },
    byEvent(event, target) {
      return events.filter((e) => e.event === event && (target === undefined || e.target === target));
    },
    last(event) {
      for (let i = events.length - 1; i >= 0; i--) if (events[i].event === event) return events[i];
      return undefined;
    },
  };
}

export interface FakeSocketData {
  user: { id: string; [k: string]: unknown };
  matchId?: string;
  connectedAt?: number;
  [k: string]: unknown;
}

export class FakeSocket {
  readonly rooms = new Set<string>();
  private listeners = new Map<string, Array<(payload: unknown) => void>>();

  constructor(
    readonly id: string,
    readonly data: FakeSocketData,
    private readonly io: FakeIo,
  ) {
    // A socket is always in its own id-room (Socket.IO semantics).
    this.rooms.add(id);
  }

  join(room: string): void {
    this.rooms.add(room);
    this.io._index(room, this);
  }

  leave(room: string): void {
    this.rooms.delete(room);
    this.io._deindex(room, this);
  }

  /** Server -> THIS client. Recorded as a per-socket emit. */
  emit(event: string, payload?: unknown): boolean {
    this.io._trace.record('server->socket', event, payload, this.id);
    return true;
  }

  /** Register a client-side handler (the engine's socket.on(...) equivalent). */
  on(event: string, handler: (payload: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  /** Deliver an inbound event to this socket's registered handlers (test-driven). */
  _deliver(event: string, payload: unknown): void {
    for (const h of this.listeners.get(event) ?? []) h(payload);
  }
}

class RoomEmitter {
  constructor(
    private readonly io: FakeIo,
    private readonly room: string | null, // null = global (io.emit/io broadcast)
  ) {}

  emit(event: string, payload?: unknown): boolean {
    this.io._trace.record('server->room', event, payload, this.room ?? '*');
    return true;
  }

  async fetchSockets(): Promise<FakeSocket[]> {
    return this.io._socketsIn(this.room);
  }
}

export class FakeIo {
  /** room -> set of sockets */
  private roomIndex = new Map<string, Set<FakeSocket>>();
  private allSockets = new Set<FakeSocket>();

  constructor(readonly _trace: EventTrace) {}

  /** Create + register a connected fake socket (one human seat). */
  createSocket(id: string, data: FakeSocketData): FakeSocket {
    const socket = new FakeSocket(id, data, this);
    this.allSockets.add(socket);
    this._index(id, socket);
    return socket;
  }

  /** Remove a socket entirely (models a disconnect at the transport level). */
  removeSocket(socket: FakeSocket): void {
    for (const room of socket.rooms) this._deindex(room, socket);
    this.allSockets.delete(socket);
  }

  to(room: string): RoomEmitter {
    return new RoomEmitter(this, room);
  }

  in(room: string): RoomEmitter {
    return new RoomEmitter(this, room);
  }

  /** Global broadcast. */
  emit(event: string, payload?: unknown): boolean {
    this._trace.record('server->room', event, payload, '*');
    return true;
  }

  _socketsIn(room: string | null): FakeSocket[] {
    if (room === null) return [...this.allSockets];
    return [...(this.roomIndex.get(room) ?? new Set())];
  }

  _index(room: string, socket: FakeSocket): void {
    const set = this.roomIndex.get(room) ?? new Set<FakeSocket>();
    set.add(socket);
    this.roomIndex.set(room, set);
  }

  _deindex(room: string, socket: FakeSocket): void {
    this.roomIndex.get(room)?.delete(socket);
  }
}
