/**
 * Real-network client for the staging harness: a socket.io-client wrapper that
 * connects to staging with a real JWT and RECORDS every server->client event into
 * the same EventTrace shape the local harness invariants consume. This lets the
 * staging harness reuse `checkInvariants` / `checkPartyInvariants` unchanged.
 */
import { io, type Socket } from 'socket.io-client';
import { createTrace, type EventTrace } from '../src/adapter.mjs';

// The room-level events the invariants reason about. We tag recorded events as
// 'server->room' (the invariants only treat match-room broadcasts as dispatches);
// over the real network we can't tell room vs socket, but for a single observing
// client that's fine — every match:* we receive WAS broadcast to the match room.
const RECORDED_EVENTS = [
  'match:start', 'match:countdown', 'match:question', 'match:round_result',
  'match:final_results', 'match:state', 'match:party_state', 'match:resume',
  'match:rejoin_available', 'match:opponent_disconnected', 'match:halftime_ban',
  'match:answer_ack', 'match:opponent_answered', 'match:question_revealed',
  'draft:start', 'draft:banned', 'ranked:search_started', 'ranked:match_found',
  'lobby:state', 'error',
] as const;

export interface StagingClient {
  socket: Socket;
  trace: EventTrace;
  userId: string;
  /** wait until predicate true or timeout; resolves false on timeout. */
  waitFor: (predicate: () => boolean, maxMs: number) => Promise<boolean>;
  /** count of a recorded event so far. */
  count: (event: string) => number;
  /** latest payload of an event (or undefined). */
  latest: <T = unknown>(event: string) => T | undefined;
  disconnect: () => void;
}

export function connectStaging(url: string, token: string, userId: string, sharedTrace?: EventTrace): StagingClient {
  const trace = sharedTrace ?? createTrace(() => Date.now());
  const socket: Socket = io(url, {
    transports: ['websocket'],
    auth: { token },
    forceNew: true,
    autoConnect: true,
    reconnection: true,
  });

  for (const ev of RECORDED_EVENTS) {
    socket.on(ev, (payload: unknown) => {
      // Tag match-room broadcasts so the invariants treat them as dispatches; the
      // target carries the matchId when present so target-filtered checks work.
      const matchId = (payload as { matchId?: string } | undefined)?.matchId;
      const dir = ev.startsWith('match:') || ev === 'ranked:match_found' ? 'server->room' : 'server->socket';
      trace.record(dir as 'server->room' | 'server->socket', ev, payload, matchId ? `match:${matchId}` : undefined);
    });
  }
  // Surface low-level connection failures (bad token, network) clearly.
  socket.on('connect_error', (err: Error) => {
    trace.record('server->socket', 'error', { code: 'CONNECT_ERROR', message: err.message });
  });

  const waitFor = async (predicate: () => boolean, maxMs: number): Promise<boolean> => {
    const deadline = Date.now() + maxMs;
    if (predicate()) return true;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (predicate()) return true;
    }
    return false;
  };

  const client: StagingClient = {
    socket,
    trace,
    userId,
    waitFor,
    count: (event) => trace.byEvent(event).length,
    latest: <T,>(event: string) => trace.byEvent(event).slice(-1)[0]?.payload as T | undefined,
    disconnect: () => socket.disconnect(),
  };
  return client;
}

/**
 * Self-heal: a crashed/killed prior run can leave a staging test user in an
 * `active` match, which blocks ranked queue + lobby create ("already in an active
 * match"). On connect the server emits match:rejoin_available / a RANKED_QUEUE_BLOCKED
 * error carrying the activeMatchId — forfeit+leave it so the next scenario starts clean.
 */
export async function clearActiveMatch(client: StagingClient): Promise<string | null> {
  // Give the server a moment to emit rejoin_available / any blocked-state error.
  await new Promise((r) => setTimeout(r, 2_000));
  const rejoin = client.latest<{ matchId?: string }>('match:rejoin_available');
  const fromError = client.trace.byEvent('error')
    .map((e) => (e.payload as { meta?: { stateSnapshot?: { activeMatchId?: string } } }).meta?.stateSnapshot?.activeMatchId)
    .find(Boolean);
  const activeMatchId = rejoin?.matchId ?? fromError ?? null;
  if (activeMatchId) {
    client.socket.emit('match:forfeit', { matchId: activeMatchId });
    client.socket.emit('match:leave', { matchId: activeMatchId });
    await new Promise((r) => setTimeout(r, 2_500));
  }
  // Discard all setup/cleanup events so the scenario trace contains ONLY the real
  // match that follows (otherwise a self-heal forfeit's final_results would be
  // judged as part of the new match).
  client.trace.reset();
  return activeMatchId;
}
