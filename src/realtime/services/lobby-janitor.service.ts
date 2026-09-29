import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { lobbiesRepo } from '../../modules/lobbies/index.js';
import { acquireLock, releaseLock } from '../locks.js';
import type { QuizballServer } from '../socket-server.js';
import { acquireLobbyLockWithRetry, closeLobbyIfEmpty } from './lobby-lifecycle.helpers.js';

/**
 * Mode-agnostic stranded-lobby janitor.
 *
 * Every new game mode has shipped without lobby teardown and leaked open
 * lobbies from day one (football_grid: #715, then `duel` on its 2026-09-29
 * launch day; historic friendly/auction rows have lingered for a week). The
 * per-mode fixes keep losing that race, so this sweeps ALL modes: any lobby
 * still `waiting`/`active` after STALE_HOURS with no live socket in its room
 * and no active match is dissolved through the normal teardown path.
 *
 * The conditions mirror the prod probe's stranded-lobby check exactly — the
 * janitor acts where the probe could only page.
 */
const STALE_HOURS = 2;
const SWEEP_INTERVAL_MS = 15 * 60 * 1_000;
const STARTUP_DELAY_MS = 90_000;
const BATCH_LIMIT = 25;
const SWEEP_LOCK_KEY = 'lock:lobby-janitor:sweep';
const SWEEP_LOCK_TTL_MS = 60_000;

let startupTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

interface StrandedLobbyRow {
  id: string;
  status: string;
  game_mode: string | null;
}

async function listStrandedCandidates(): Promise<StrandedLobbyRow[]> {
  // matches.lobby_id is indexed (#633). "No active match" keeps a lobby whose
  // game is genuinely running out of scope even if its sockets briefly drop.
  return sql<StrandedLobbyRow[]>`
    SELECT l.id, l.status, l.game_mode
    FROM lobbies l
    WHERE l.status IN ('waiting', 'active')
      AND l.created_at < now() - make_interval(hours => ${STALE_HOURS})
      AND NOT EXISTS (
        SELECT 1 FROM matches m WHERE m.lobby_id = l.id AND m.status = 'active'
      )
    ORDER BY l.created_at
    LIMIT ${BATCH_LIMIT}
  `;
}

async function lobbyHasLiveSocket(io: QuizballServer, lobbyId: string): Promise<boolean> {
  try {
    const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
    return sockets.some((socket) => socket.data.lobbyId === lobbyId);
  } catch (error) {
    // Fail SAFE: if presence cannot be read, treat the lobby as live.
    logger.warn({ error, lobbyId }, 'Lobby janitor: presence check failed; skipping lobby');
    return true;
  }
}

async function sweepLobby(io: QuizballServer, row: StrandedLobbyRow): Promise<boolean> {
  const lock = await acquireLobbyLockWithRetry(row.id, 3_000, 500);
  if (!lock.acquired || !lock.token) return false;
  try {
    // Re-check under the lock: a join/match-start may have raced the sweep.
    const fresh = await lobbiesRepo.getById(row.id);
    if (!fresh || !['waiting', 'active'].includes(fresh.status)) return false;
    if (await lobbyHasLiveSocket(io, row.id)) return false;

    // Remove members through the repo so FK state stays consistent, then let
    // the standard teardown delete the empty lobby and clean warmup state.
    const memberRows = await sql<Array<{ user_id: string }>>`
      SELECT user_id FROM lobby_members WHERE lobby_id = ${row.id}
    `;
    for (const member of memberRows) {
      await lobbiesRepo.removeMember(row.id, member.user_id);
    }
    const closed = await closeLobbyIfEmpty(io, row.id);
    if (closed) {
      logger.info(
        { lobbyId: row.id, gameMode: row.game_mode, status: row.status, membersRemoved: memberRows.length },
        'Lobby janitor: dissolved stranded lobby'
      );
    }
    return closed;
  } finally {
    await releaseLock(`lock:lobby:${row.id}`, lock.token).catch(() => {});
  }
}

async function sweep(io: QuizballServer): Promise<void> {
  const lock = await acquireLock(SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) return; // another replica is sweeping
  try {
    const candidates = await listStrandedCandidates();
    if (candidates.length === 0) return;
    let swept = 0;
    for (const row of candidates) {
      if (await sweepLobby(io, row)) swept += 1;
    }
    if (swept > 0) {
      logger.info({ candidates: candidates.length, swept }, 'Lobby janitor sweep complete');
    }
  } catch (error) {
    logger.error({ error }, 'Lobby janitor sweep failed');
  } finally {
    await releaseLock(SWEEP_LOCK_KEY, lock.token).catch(() => {});
  }
}

export const lobbyJanitorService = {
  start(io: QuizballServer): void {
    if (startupTimer || intervalTimer) return;
    startupTimer = setTimeout(() => {
      startupTimer = null;
      void sweep(io);
    }, STARTUP_DELAY_MS);
    startupTimer.unref?.();
    intervalTimer = setInterval(() => void sweep(io), SWEEP_INTERVAL_MS);
    intervalTimer.unref?.();
  },
  stop(): void {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  },
  sweep,
  __internals: { listStrandedCandidates, sweepLobby, lobbyHasLiveSocket, STALE_HOURS },
};
