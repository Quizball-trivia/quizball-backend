import type { EventTrace, TraceEvent } from './adapter.mjs';
import type { Violation } from './invariants.mjs';
import { sql } from '../../src/db/index.js';
import { getRedisClient } from '../../src/realtime/redis.js';
import { RANKED_MM_USER_MAP_KEY } from '../../src/realtime/ranked-matchmaking-keys.js';
import { matchPauseKey } from '../../src/realtime/match-keys.js';

type ClientStage = 'idle' | 'searching' | 'found' | 'draft' | 'gate' | 'halftime' | 'question' | 'paused' | 'result';

interface ClientTruthState {
  stage: ClientStage;
  matchId: string | null;
  lobbyId: string | null;
  qIndex: number | null;
  banCount: number;
  lastSeq: number | null;
}

interface ServerTruthState {
  stage: ClientStage;
  matchId: string | null;
  lobbyId: string | null;
  qIndex: number | null;
  banCount: number;
  status: string | null;
  phase: string | null;
  queueSearchId: string | null;
}

function payloadRecord(event: TraceEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

function payloadString(event: TraceEvent, key: string): string | null {
  const value = payloadRecord(event)[key];
  return typeof value === 'string' ? value : null;
}

function payloadNumber(event: TraceEvent, key: string): number | null {
  const value = payloadRecord(event)[key];
  return typeof value === 'number' ? value : null;
}

function clientReceivedEvent(event: TraceEvent, userId: string, matchId: string | null): boolean {
  if (event.dir === 'client->server') return false;
  if (event.target === `user:${userId}`) return true;
  if (matchId && event.target === `match:${matchId}`) return true;
  if (typeof event.target === 'string' && event.target.startsWith('lobby:')) return true;
  return event.dir === 'server->socket';
}

export function buildClientTruthModel(trace: EventTrace, params: { userId: string; matchId?: string | null }): ClientTruthState {
  const state: ClientTruthState = {
    stage: 'idle',
    matchId: params.matchId ?? null,
    lobbyId: null,
    qIndex: null,
    banCount: 0,
    lastSeq: null,
  };

  for (const event of trace.events) {
    if (!clientReceivedEvent(event, params.userId, state.matchId)) continue;
    state.lastSeq = event.seq;
    if (event.event === 'ranked:search_started') {
      state.stage = 'searching';
    } else if (event.event === 'ranked:queue_left') {
      state.stage = 'idle';
    } else if (event.event === 'ranked:match_found') {
      state.stage = 'found';
      state.lobbyId = payloadString(event, 'lobbyId') ?? state.lobbyId;
    } else if (event.event === 'draft:start' || event.event === 'draft:turn' || event.event === 'draft:banned') {
      state.stage = 'draft';
      state.lobbyId = payloadString(event, 'lobbyId') ?? state.lobbyId;
      if (event.event === 'draft:banned') state.banCount += 1;
    } else if (event.event === 'match:start') {
      state.stage = 'gate';
      state.matchId = payloadString(event, 'matchId') ?? state.matchId;
    } else if (event.event === 'match:waiting_for_ready') {
      state.stage = 'gate';
      state.matchId = payloadString(event, 'matchId') ?? state.matchId;
    } else if (event.event === 'match:state') {
      state.matchId = payloadString(event, 'matchId') ?? state.matchId;
      state.stage = payloadString(event, 'phase') === 'HALFTIME' ? 'halftime' : state.stage;
    } else if (event.event === 'match:question') {
      state.stage = 'question';
      state.matchId = payloadString(event, 'matchId') ?? state.matchId;
      state.qIndex = payloadNumber(event, 'qIndex') ?? state.qIndex;
    } else if (event.event === 'match:pause' || event.event === 'match:opponent_disconnected' || event.event === 'match:rejoin_available') {
      state.stage = 'paused';
      state.matchId = payloadString(event, 'matchId') ?? state.matchId;
    } else if (event.event === 'match:resume') {
      state.stage = state.qIndex === null ? 'gate' : 'question';
      state.matchId = payloadString(event, 'matchId') ?? state.matchId;
    } else if (event.event === 'match:final_results' || event.event === 'match:party_dropout') {
      state.stage = 'result';
      state.matchId = payloadString(event, 'matchId') ?? state.matchId;
    }
  }

  return state;
}

async function loadServerTruth(userId: string, matchId: string | null): Promise<ServerTruthState> {
  const redis = getRedisClient();
  const queueSearchId = redis?.isOpen ? await redis.hGet(RANKED_MM_USER_MAP_KEY, userId) : null;
  if (queueSearchId) {
    return {
      stage: 'searching',
      matchId: null,
      lobbyId: null,
      qIndex: null,
      banCount: 0,
      status: null,
      phase: null,
      queueSearchId,
    };
  }

  const [match] = matchId
    ? await sql<Array<{
        id: string;
        status: string;
        current_q_index: number;
        lobby_id: string | null;
        state_payload: unknown;
      }>>`
        SELECT id, status, current_q_index, lobby_id, state_payload
        FROM matches
        WHERE id = ${matchId}
      `
    : [];
  const [lobby] = !match
    ? await sql<Array<{ id: string; status: string }>>`
        SELECT l.id, l.status
        FROM lobbies l
        JOIN lobby_members lm ON lm.lobby_id = l.id
        WHERE lm.user_id = ${userId}
        ORDER BY l.created_at DESC
        LIMIT 1
      `
    : [];
  const lobbyId = match?.lobby_id ?? lobby?.id ?? null;
  const [{ count: banCount } = { count: 0 }] = lobbyId
    ? await sql<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM lobby_category_bans WHERE lobby_id = ${lobbyId}
      `
    : [{ count: 0 }];

  if (!match) {
    return {
      stage: lobby?.status === 'active' ? 'draft' : 'idle',
      matchId: null,
      lobbyId,
      qIndex: null,
      banCount,
      status: null,
      phase: null,
      queueSearchId: null,
    };
  }

  const phase = match.state_payload && typeof match.state_payload === 'object' && !Array.isArray(match.state_payload)
    ? typeof (match.state_payload as { phase?: unknown }).phase === 'string'
      ? (match.state_payload as { phase: string }).phase
      : null
    : null;
  const paused = redis?.isOpen ? (await redis.exists(matchPauseKey(match.id))) === 1 : false;
  const stage: ClientStage =
    match.status === 'completed' || match.status === 'abandoned'
      ? 'result'
      : paused
        ? 'paused'
        : phase === 'HALFTIME'
          ? 'halftime'
          : 'question';

  return {
    stage,
    matchId: match.id,
    lobbyId,
    qIndex: match.current_q_index,
    banCount,
    status: match.status,
    phase,
    queueSearchId: null,
  };
}

export async function checkClientTruth(
  trace: EventTrace,
  params: { userId: string; matchId?: string | null }
): Promise<{ ok: boolean; violations: Violation[]; client: ClientTruthState; server: ServerTruthState }> {
  const client = buildClientTruthModel(trace, params);
  const server = await loadServerTruth(params.userId, params.matchId ?? client.matchId);
  const violations: Violation[] = [];

  if (client.stage !== server.stage) {
    violations.push({
      invariant: 'clientTruthDivergence',
      message: `Client model stage "${client.stage}" diverged from server truth "${server.stage}".`,
      seq: client.lastSeq ?? undefined,
      detail: { userId: params.userId, client, server },
    });
  }
  if (server.stage === 'question' && client.qIndex !== null && client.qIndex !== server.qIndex) {
    violations.push({
      invariant: 'clientTruthDivergence',
      message: `Client qIndex ${client.qIndex} diverged from server qIndex ${server.qIndex}.`,
      seq: client.lastSeq ?? undefined,
      detail: { userId: params.userId, client, server },
    });
  }
  if (server.banCount > 0 && client.banCount < server.banCount && client.stage !== 'result') {
    violations.push({
      invariant: 'clientTruthDivergence',
      message: `Client saw ${client.banCount} draft ban(s), server has ${server.banCount}.`,
      seq: client.lastSeq ?? undefined,
      detail: { userId: params.userId, client, server },
    });
  }

  return { ok: violations.length === 0, violations, client, server };
}
