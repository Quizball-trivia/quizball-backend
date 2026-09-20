/* eslint-disable no-console */
/**
 * Real staging smoke for the Football Tic Tac Toe friend-lobby path.
 *
 * Creates two authenticated test users and drives the full flow:
 * lobby create -> join by code -> select football_grid -> both ready -> host
 * start -> handoff/ready -> 40 bounded wrong-answer turns -> completion ACK.
 * Production is blocked by exact API and Supabase identity guards.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  clearActiveMatch,
  connectStaging,
  type StagingClient,
} from '../../game-regression/staging/staging-client.mjs';
import { provisionUsers, type ChaosUser } from './auth.js';

const API_BASE = 'https://api-staging.quizball.io';
const STAGING_PROJECT = 'nsdfiprfmhdqhbfxfwpv';
const PRODUCTION_PROJECT = 'lfbwhxvwubzeqkztghok';
const GAME_MODE = 'football_grid';
const TIMEOUT_MS = 180_000;

interface GridState {
  matchId: string;
  phase: 'handoff' | 'loading' | 'countdown' | 'turn' | 'paused' | 'service_interruption' | 'terminal';
  stateVersion: number;
  turnNumber: number;
  currentPlayerUserId: string | null;
  completionReason: string | null;
  players: Array<{
    userId: string;
    isBot: boolean;
    handoffAcknowledged: boolean;
    ready: boolean;
  }>;
}

interface StatePayload {
  matchId: string;
  state: GridState;
}

interface CompletedPayload extends StatePayload {
  terminalStateVersion: number;
  ackToken: string;
  rewards?: { xp: number; coins: number; tp: number };
}

interface ClientObservation {
  matchId: string | null;
  humanOnly: boolean;
  completed: CompletedPayload | null;
  commands: number;
  wrongAnswers: number;
  errors: Array<{ code?: string; message?: string }>;
}

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const output: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let raw = match[2]!;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    }
    output[match[1]!] = raw;
  }
  return output;
}

function waitFor(predicate: () => boolean, maxMs: number): Promise<boolean> {
  return new Promise((resolveWait) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate() || Date.now() - startedAt >= maxMs) {
        clearInterval(timer);
        resolveWait(predicate());
      }
    }, 50);
  });
}

function attachGridPlayer(client: StagingClient, user: ChaosUser): ClientObservation {
  const observation: ClientObservation = {
    matchId: null,
    humanOnly: true,
    completed: null,
    commands: 0,
    wrongAnswers: 0,
    errors: [],
  };
  const acknowledgedVersions = new Set<number>();
  const readyVersions = new Set<number>();
  const actedVersions = new Set<number>();
  let heartbeat: NodeJS.Timeout | null = null;

  const handleState = (state: GridState) => {
    if (!observation.matchId || state.matchId !== observation.matchId) return;
    const player = state.players.find((candidate) => candidate.userId === user.userId);
    if (state.phase === 'loading' && !player?.ready && !readyVersions.has(state.stateVersion)) {
      readyVersions.add(state.stateVersion);
      client.socket.emit('grid:client_ready', {
        matchId: state.matchId,
        commandId: randomUUID(),
        expectedStateVersion: state.stateVersion,
      });
    }
    if (state.phase !== 'turn'
      || state.currentPlayerUserId !== user.userId
      || actedVersions.has(state.stateVersion)) return;
    actedVersions.add(state.stateVersion);
    client.socket.emit('grid:submit_answer', {
      matchId: state.matchId,
      commandId: randomUUID(),
      expectedStateVersion: state.stateVersion,
      cellIndex: state.turnNumber % 9,
      text: `zz lobby smoke ${user.userId.slice(0, 8)} ${state.turnNumber}`,
      locale: 'en',
    });
  };

  client.socket.on('grid:match_found', (payload: StatePayload) => {
    observation.matchId = payload.matchId;
    observation.humanOnly = payload.state.players.every((player) => !player.isBot);
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        if (observation.matchId) {
          client.socket.emit('grid:presence_heartbeat', { matchId: observation.matchId });
        }
      }, 5_000);
      heartbeat.unref?.();
    }
    const player = payload.state.players.find((candidate) => candidate.userId === user.userId);
    if (!player?.handoffAcknowledged && !acknowledgedVersions.has(payload.state.stateVersion)) {
      acknowledgedVersions.add(payload.state.stateVersion);
      client.socket.emit('grid:match_found_ack', {
        matchId: payload.matchId,
        commandId: randomUUID(),
        expectedStateVersion: payload.state.stateVersion,
      });
    }
    handleState(payload.state);
  });
  for (const event of ['grid:loading_state', 'grid:countdown', 'grid:state', 'grid:turn_resolved']) {
    client.socket.on(event, (payload: StatePayload) => handleState(payload.state));
  }
  client.socket.on('grid:command_result', (payload: { outcome?: string }) => {
    observation.commands += 1;
    if (payload.outcome === 'wrong') observation.wrongAnswers += 1;
  });
  client.socket.on('grid:error', (payload: { code?: string; message?: string }) => {
    observation.errors.push(payload);
  });
  client.socket.on('grid:completed', (payload: CompletedPayload) => {
    observation.completed = payload;
    if (heartbeat) clearInterval(heartbeat);
    client.socket.emit('grid:completed_ack', {
      matchId: payload.matchId,
      terminalStateVersion: payload.terminalStateVersion,
      ackToken: payload.ackToken,
    });
  });
  return observation;
}

function assertFriendlyRewards(payload: CompletedPayload | null, label: string): void {
  if (!payload?.rewards) throw new Error(`${label} did not receive rewards.`);
  if (payload.rewards.xp <= 0) throw new Error(`${label} did not receive XP.`);
  if (payload.rewards.coins !== 0 || payload.rewards.tp !== 0) {
    throw new Error(`${label} friendly rewards were xp=${payload.rewards.xp} coins=${payload.rewards.coins} tp=${payload.rewards.tp}.`);
  }
}

async function runBrowserOpponent(user: ChaosUser, inviteCode: string): Promise<void> {
  const client = connectStaging(API_BASE, user.token, user.userId);
  try {
    if (!await waitFor(() => client.socket.connected, 20_000)) {
      throw new Error('Browser opponent did not connect.');
    }
    await clearActiveMatch(client);
    const grid = attachGridPlayer(client, user);
    let memberCount = 0;
    let selectedMode: string | null = null;
    let readySent = false;
    const startedAt = Date.now();
    client.socket.on('lobby:state', (state: {
      members?: Array<{ isReady?: boolean }>;
      settings?: { gameMode?: string };
    }) => {
      memberCount = state.members?.length ?? memberCount;
      selectedMode = state.settings?.gameMode ?? selectedMode;
      if (memberCount === 2 && selectedMode === GAME_MODE && !readySent) {
        readySent = true;
        client.socket.emit('lobby:ready', { ready: true });
      }
    });
    client.socket.emit('lobby:join_by_code', { inviteCode });
    if (!await waitFor(() => memberCount === 2 && selectedMode === GAME_MODE, 30_000)) {
      throw new Error(`Browser lobby was not joinable: members=${memberCount} mode=${selectedMode ?? 'null'}.`);
    }
    if (!await waitFor(() => Boolean(grid.matchId), 90_000)) {
      throw new Error('Browser host did not start the grid match.');
    }
    if (!await waitFor(() => Boolean(grid.completed), TIMEOUT_MS)) {
      throw new Error('Browser-hosted grid match did not complete.');
    }
    if (!grid.humanOnly || grid.errors.length) {
      throw new Error(`Browser-hosted grid errors: ${JSON.stringify(grid.errors)}.`);
    }
    assertFriendlyRewards(grid.completed, 'browser opponent');
    console.log(JSON.stringify({
      verdict: 'PASS',
      path: 'browser_host_socket_opponent',
      inviteCode,
      selectedMode,
      humanOnly: true,
      matchId: grid.matchId,
      completionReason: grid.completed?.state.completionReason,
      commands: grid.commands,
      elapsedMs: Date.now() - startedAt,
      rewards: grid.completed?.rewards,
    }, null, 2));
  } finally {
    client.disconnect();
  }
}

async function main(): Promise<void> {
  const env = readEnv(resolve(process.cwd(), '.env'));
  const supabaseUrl = process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const bypassToken = process.env.CHAOS_BYPASS_TOKEN ?? env.CHAOS_BYPASS_TOKEN;
  const identity = `${API_BASE} ${supabaseUrl}`;
  if (identity.includes(PRODUCTION_PROJECT) || API_BASE.includes('api.quizball.io')) {
    throw new Error('PRODUCTION GUARD: refusing lobby smoke outside staging.');
  }
  if (!supabaseUrl.includes(STAGING_PROJECT) || !serviceRoleKey || !bypassToken) {
    throw new Error('STAGING IDENTITY GUARD: staging Supabase and chaos credentials are required.');
  }

  const joinCodeArg = process.argv.find((argument) => argument.startsWith('--join-code='));
  const joinCode = joinCodeArg?.slice('--join-code='.length).trim().toUpperCase() || null;
  if (joinCode && !/^[A-Z0-9]{6}$/.test(joinCode)) throw new Error('--join-code must be six letters/digits.');
  const users = await provisionUsers({
    apiBase: API_BASE,
    supabaseUrl,
    serviceRoleKey,
    count: joinCode ? 1 : 2,
    startIndex: joinCode ? 10 : 0,
    password: 'ChaosTest12345!',
    emailPrefix: joinCode ? 'grid-lobby-browser-opponent' : 'grid-lobby-smoke',
    emailDomain: 'quizball.io',
    concurrency: 1,
    loginIntervalMs: 2_200,
    bypassToken,
  });
  if (joinCode) {
    await runBrowserOpponent(users[0]!, joinCode);
    return;
  }
  const host = connectStaging(API_BASE, users[0]!.token, users[0]!.userId);
  const guest = connectStaging(API_BASE, users[1]!.token, users[1]!.userId);
  try {
    const connected = await waitFor(() => host.socket.connected && guest.socket.connected, 20_000);
    if (!connected) throw new Error('Both clients did not connect.');
    await Promise.all([clearActiveMatch(host), clearActiveMatch(guest)]);

    const hostGrid = attachGridPlayer(host, users[0]!);
    const guestGrid = attachGridPlayer(guest, users[1]!);
    let inviteCode: string | null = null;
    let memberCount = 0;
    let selectedMode: string | null = null;
    let allReady = false;
    let guestJoined = false;
    let settingsSent = false;
    const createdAt = Date.now();

    host.socket.on('lobby:state', (state: {
      inviteCode?: string | null;
      members?: Array<{ isReady?: boolean }>;
      settings?: { gameMode?: string };
    }) => {
      inviteCode = state.inviteCode ?? inviteCode;
      memberCount = state.members?.length ?? memberCount;
      selectedMode = state.settings?.gameMode ?? selectedMode;
      allReady = memberCount === 2 && Boolean(state.members?.every((member) => member.isReady));
      if (inviteCode && !guestJoined) {
        guestJoined = true;
        guest.socket.emit('lobby:join_by_code', { inviteCode });
      }
      if (memberCount === 2 && !settingsSent) {
        settingsSent = true;
        host.socket.emit('lobby:update_settings', { gameMode: GAME_MODE });
      }
    });
    host.socket.emit('lobby:create', { mode: 'friendly' });
    const lobbyReady = await waitFor(
      () => memberCount === 2 && selectedMode === GAME_MODE,
      30_000,
    );
    if (!lobbyReady) {
      throw new Error(`Lobby was not ready: members=${memberCount} mode=${selectedMode ?? 'null'}.`);
    }
    host.socket.emit('lobby:ready', { ready: true });
    guest.socket.emit('lobby:ready', { ready: true });
    if (!await waitFor(() => allReady, 30_000)) throw new Error('Both lobby members were not ready.');
    host.socket.emit('lobby:start', {});

    const matched = await waitFor(
      () => Boolean(hostGrid.matchId && hostGrid.matchId === guestGrid.matchId),
      60_000,
    );
    if (!matched) throw new Error('Both lobby members did not receive the same grid match.');
    const completed = await waitFor(
      () => Boolean(hostGrid.completed && guestGrid.completed),
      TIMEOUT_MS,
    );
    if (!completed) throw new Error('The friend-lobby grid match did not complete.');
    if (!hostGrid.humanOnly || !guestGrid.humanOnly) throw new Error('Friend lobby unexpectedly used a bot.');
    if (hostGrid.errors.length || guestGrid.errors.length) {
      throw new Error(`Grid errors: ${JSON.stringify([...hostGrid.errors, ...guestGrid.errors])}`);
    }
    assertFriendlyRewards(hostGrid.completed, 'host');
    assertFriendlyRewards(guestGrid.completed, 'guest');

    console.log(JSON.stringify({
      verdict: 'PASS',
      inviteCode,
      selectedMode,
      players: 2,
      humanOnly: true,
      matchId: hostGrid.matchId,
      completionReason: hostGrid.completed?.state.completionReason,
      turnsResolved: hostGrid.wrongAnswers + guestGrid.wrongAnswers,
      commands: hostGrid.commands + guestGrid.commands,
      elapsedMs: Date.now() - createdAt,
      rewards: {
        host: hostGrid.completed?.rewards,
        guest: guestGrid.completed?.rewards,
      },
    }, null, 2));
  } finally {
    host.disconnect();
    guest.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
