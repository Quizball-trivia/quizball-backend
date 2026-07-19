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
  'match:answer_ack', 'match:opponent_answered', 'match:waiting_for_ready',
  'draft:start', 'draft:banned', 'draft:complete', 'draft:resume',
  'ranked:search_started', 'ranked:match_found', 'ranked:queue_left',
  'lobby:state', 'session:state', 'session:blocked', 'error',
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
 * Self-heal all durable session state from a crashed/killed prior run. Active
 * matches, waiting lobbies, and ranked queue searches all block a fresh queue
 * join, so a capacity run is invalid unless every test identity starts clean.
 */
export async function clearActiveMatch(client: StagingClient): Promise<string | null> {
  // Give the server a moment to emit rejoin/state/session information. A live
  // match is often auto-rejoined as `match:state` (not `rejoin_available`), so
  // looking only for the latter silently reused dirty test accounts.
  await new Promise((r) => setTimeout(r, 2_000));
  const rejoin = client.latest<{ matchId?: string }>('match:rejoin_available');
  const matchState = client.latest<{ matchId?: string }>('match:state');
  const sessionState = client.latest<{ activeMatchId?: string | null }>('session:state');
  const fromError = client.trace.byEvent('error')
    .map((e) => (e.payload as { meta?: { stateSnapshot?: { activeMatchId?: string } } }).meta?.stateSnapshot?.activeMatchId)
    .find(Boolean);
  const activeMatchId = rejoin?.matchId
    ?? matchState?.matchId
    ?? sessionState?.activeMatchId
    ?? fromError
    ?? null;
  if (activeMatchId) {
    client.socket.emit('match:forfeit', { matchId: activeMatchId });
    client.socket.emit('match:leave', { matchId: activeMatchId });
    // Do not start the measured queue join while cleanup is still racing in the
    // background. Final results or a session snapshot without the active match
    // both prove the user is reusable; retain a bounded fallback for older
    // staging builds that do not emit the session transition.
    const cleared = await client.waitFor(() => {
      const latestSession = client.latest<{
        activeMatchId?: string | null;
        state?: string;
      }>('session:state');
      const finalResultForMatch = client.trace.byEvent('match:final_results')
        .some((event) => (event.payload as { matchId?: string }).matchId === activeMatchId);
      return finalResultForMatch
        || Boolean(latestSession && latestSession.activeMatchId !== activeMatchId);
    }, 10_000);
    if (!cleared) {
      throw new Error(`staging cleanup could not clear active match ${activeMatchId}`);
    }
  }

  let latestSession = client.latest<{
    waitingLobbyId?: string | null;
    queueSearchId?: string | null;
  }>('session:state');
  const waitingLobbyId = latestSession?.waitingLobbyId ?? null;
  if (waitingLobbyId) {
    const correlationId = `load-cleanup-${userSafeId(client.userId)}-${Date.now()}`;
    const leaveResult = await new Promise<{ ok?: boolean; code?: string } | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 10_000);
      timeout.unref?.();
      client.socket.emit('lobby:leave', { correlationId }, (result: { ok?: boolean; code?: string }) => {
        clearTimeout(timeout);
        resolve(result);
      });
    });
    const cleared = await client.waitFor(() => {
      const state = client.latest<{ waitingLobbyId?: string | null }>('session:state');
      return Boolean(state && state.waitingLobbyId !== waitingLobbyId);
    }, 10_000);
    if (!cleared) {
      throw new Error(
        `staging cleanup could not leave waiting lobby ${waitingLobbyId}` +
        `${leaveResult?.code ? ` (${leaveResult.code})` : ''}`
      );
    }
  }

  latestSession = client.latest<{ queueSearchId?: string | null }>('session:state');
  const queueSearchId = latestSession?.queueSearchId ?? null;
  if (queueSearchId) {
    client.socket.emit('ranked:queue_leave');
    const cleared = await client.waitFor(() => {
      const state = client.latest<{ queueSearchId?: string | null }>('session:state');
      return Boolean(state && state.queueSearchId === null);
    }, 10_000);
    if (!cleared) {
      throw new Error(`staging cleanup could not leave ranked search ${queueSearchId}`);
    }
  }
  // Discard all setup/cleanup events so the scenario trace contains ONLY the real
  // match that follows (otherwise a self-heal forfeit's final_results would be
  // judged as part of the new match).
  client.trace.reset();
  return activeMatchId;
}

function userSafeId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
}
