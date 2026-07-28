/**
 * Live-DB reads the burn-in engine needs: the persistent roster, the hard
 * ceiling (human top-10 RP), the active category pool, and the one-time
 * burn-in marker guard.
 */
import { sql, type TransactionSql } from '../../src/db/index.js';
import { SEASON_INITIAL_RP } from '../../src/modules/ranked/season-rp-formula.js';
import type { BurnInBot, BotSchedule } from './types.js';

const BURN_IN_MARKER_NOTE = 'persistent-bot-burnin:complete';

interface RawScheduleJson {
  activeHours?: unknown;
  sessionMax?: unknown;
  intraSessionGapMin?: unknown;
}

function parseSchedule(raw: unknown): BotSchedule {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as RawScheduleJson;
  const activeHours = Array.isArray(obj.activeHours)
    ? obj.activeHours.filter((h): h is number => typeof h === 'number' && h >= 0 && h <= 23)
    : [];
  const sessionMax = typeof obj.sessionMax === 'number' && obj.sessionMax > 0 ? Math.floor(obj.sessionMax) : 4;
  const intraSessionGapMin =
    typeof obj.intraSessionGapMin === 'number' && obj.intraSessionGapMin > 0
      ? Math.floor(obj.intraSessionGapMin)
      : 20;
  return { activeHours, sessionMax, intraSessionGapMin };
}

/** Load the persistent roster joined with its ranked profile + synthetic row. */
export async function loadRoster(limit: number | null): Promise<BurnInBot[]> {
  const rows = await sql<
    Array<{
      user_id: string;
      nickname: string;
      base_skill: number;
      daily_cap: number;
      schedule: unknown;
      status: string;
      rp: number | null;
      placement_played: number | null;
      placement_wins: number | null;
      placement_status: string | null;
      current_win_streak: number | null;
    }>
  >`
    SELECT
      u.id AS user_id,
      u.nickname,
      spp.base_skill,
      spp.daily_cap,
      spp.schedule,
      spp.status,
      rp.rp,
      rp.placement_played,
      rp.placement_wins,
      rp.placement_status,
      rp.current_win_streak
    FROM users u
    JOIN synthetic_player_profiles spp ON spp.user_id = u.id
    LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
    WHERE u.is_ai = true
      AND u.ai_kind = 'persistent'
      AND u.is_deleted = false
    ORDER BY spp.base_skill DESC, u.id ASC
    ${limit != null ? sql`LIMIT ${limit}` : sql``}
  `;

  return rows.map((r) => ({
    userId: r.user_id,
    nickname: r.nickname,
    baseSkill: Number(r.base_skill),
    dailyCap: Number(r.daily_cap),
    schedule: parseSchedule(r.schedule),
    status: (r.status === 'resting' || r.status === 'retired' ? r.status : 'active') as BurnInBot['status'],
    rp: r.rp ?? 0,
    placementPlayed: r.placement_played ?? 0,
    placementWins: r.placement_wins ?? 0,
    placementStatus: (r.placement_status ?? 'unplaced') as BurnInBot['placementStatus'],
    currentWinStreak: r.current_win_streak ?? 0,
  }));
}

/**
 * Live human top-10 RP for the hard ceiling. HUMANS ONLY (is_ai=false) — the
 * ceiling exists so bots never rank above real players. Returns null if fewer
 * than 10 placed humans exist yet (caller falls back to a conservative cap).
 */
export async function loadHumanTop10Rp(): Promise<number | null> {
  const rows = await sql<{ rp: number }[]>`
    SELECT rp.rp
    FROM ranked_profiles rp
    JOIN users u ON u.id = rp.user_id
    WHERE u.is_ai = false
      AND u.is_seed = false
      AND u.is_deleted = false
      AND u.deleted_at IS NULL
      AND u.pending_deletion_at IS NULL
      AND rp.placement_status = 'placed'
    ORDER BY rp.rp DESC
    LIMIT 10
  `;
  if (rows.length < 10) return rows.length > 0 ? rows[rows.length - 1].rp : null;
  return rows[9].rp;
}

/** Active category id pool for plausible per-match category selection. */
export async function loadActiveCategoryIds(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM categories WHERE is_active = true ORDER BY id ASC
  `;
  return rows.map((r) => r.id);
}

// Constant key for the pg_advisory_XACT_lock that serializes the claim/decision
// transaction. Transaction-mode Supavisor (the pooler burn-in connects through)
// does NOT support SESSION advisory locks, so we use an XACT lock — held only
// for the duration of the claim tx — plus a durable LOCK-ROW (the marker itself,
// carrying an owner token + heartbeat) that every fixture write re-checks
// fail-closed. P1-3.
const BURN_IN_ADVISORY_LOCK_KEY = 728_150_100; // mirrors the migration date
// A run whose heartbeat is older than this is considered dead and may be taken
// over by a resume of the SAME manifest.
const HEARTBEAT_STALE_MS = 60_000;

/** Run-marker (= durable lock row) stored in bot_model_params.params. */
export interface RunMarker {
  kind: 'burnin-marker';
  manifestHash: string;
  status: 'running' | 'complete';
  /** Random per-process token; every fixture write re-checks it (fail-closed). */
  ownerToken: string;
  seed: number;
  fixtureCount?: number;
  startedAt: string;
  heartbeatAt: string;
  completedAt?: string;
}

export class LockLostError extends Error {}

export type RunDecision =
  | { kind: 'fresh'; ownerToken: string }
  | { kind: 'resume'; ownerToken: string; marker: RunMarker }
  | { kind: 'refuse'; reason: string };

function newOwnerToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Atomically claim the run under an xact advisory lock (pooler-safe). Applies
 * the decision table and, on fresh/resume, writes the marker with OUR owner
 * token so subsequent writes can re-verify ownership. Serialized against every
 * other --execute/rollback because they all take the same xact lock.
 *   - no marker                          → fresh (insert 'running' + our token)
 *   - 'complete'                         → refuse
 *   - 'running' + different H            → refuse
 *   - 'running' + same H + fresh HB      → refuse (another live process owns it)
 *   - 'running' + same H + STALE HB      → resume (take over the token)
 */
export async function claimRun(manifestHash: string, seed: number): Promise<RunDecision> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${BURN_IN_ADVISORY_LOCK_KEY})`;
    const rows = await tx<{ params: RunMarker }[]>`
      SELECT params FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE} LIMIT 1
    `;
    if (rows.length === 0) {
      const ownerToken = newOwnerToken();
      const marker: RunMarker = {
        kind: 'burnin-marker', manifestHash, status: 'running', ownerToken, seed,
        startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
      };
      await tx`
        INSERT INTO bot_model_params (params, active, note)
        VALUES (${sql.json(marker as unknown as Record<string, unknown>)}, false, ${BURN_IN_MARKER_NOTE})
      `;
      return { kind: 'fresh', ownerToken };
    }
    const marker = rows[0].params;
    if (marker.manifestHash !== manifestHash) {
      return { kind: 'refuse', reason: `a DIFFERENT burn-in run (manifest ${marker.manifestHash}, status ${marker.status}) exists — refusing` };
    }
    if (marker.status === 'complete') {
      return { kind: 'refuse', reason: `this run (manifest ${manifestHash}) is already COMPLETE — refusing` };
    }
    // status 'running' + same H: only a STALE heartbeat may be taken over.
    const ageMs = Date.now() - new Date(marker.heartbeatAt).getTime();
    if (ageMs < HEARTBEAT_STALE_MS) {
      return { kind: 'refuse', reason: `another live process owns this run (heartbeat ${Math.round(ageMs / 1000)}s ago) — refusing` };
    }
    const ownerToken = newOwnerToken();
    await tx`
      UPDATE bot_model_params
      SET params = params || ${sql.json({ ownerToken, heartbeatAt: new Date().toISOString() })}
      WHERE note = ${BURN_IN_MARKER_NOTE}
    `;
    return { kind: 'resume', ownerToken, marker: { ...marker, ownerToken } };
  }) as Promise<RunDecision>;
}

/**
 * Fail-closed ownership assertion, called before/around every fixture write. If
 * the marker row is gone, no longer 'running', or owned by a DIFFERENT token,
 * the lock was lost (a takeover/rollback happened) → abort. Throws LockLostError.
 */
export async function assertRunOwned(tx: TransactionSql, manifestHash: string, ownerToken: string): Promise<void> {
  const rows = await tx<{ params: RunMarker }[]>`
    SELECT params FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE} LIMIT 1
  `;
  const m = rows[0]?.params;
  if (!m || m.status !== 'running' || m.manifestHash !== manifestHash || m.ownerToken !== ownerToken) {
    throw new LockLostError(`burn-in lock lost (owner ${m?.ownerToken ?? 'none'} != ${ownerToken}) — aborting fail-closed`);
  }
}

/** Bump the heartbeat for our owned run (called periodically during the loop). */
export async function heartbeatRun(manifestHash: string, ownerToken: string): Promise<void> {
  await sql`
    UPDATE bot_model_params
    SET params = params || ${sql.json({ heartbeatAt: new Date().toISOString() })}
    WHERE note = ${BURN_IN_MARKER_NOTE}
      AND params->>'manifestHash' = ${manifestHash}
      AND params->>'ownerToken' = ${ownerToken}
  `;
}

/** Flip the marker to 'complete' (verifies ownership under the xact lock). */
export async function markRunComplete(manifestHash: string, ownerToken: string, fixtureCount: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${BURN_IN_ADVISORY_LOCK_KEY})`;
    await assertRunOwned(tx, manifestHash, ownerToken);
    await tx`
      UPDATE bot_model_params
      SET params = params || ${sql.json({ status: 'complete', fixtureCount, completedAt: new Date().toISOString() })}
      WHERE note = ${BURN_IN_MARKER_NOTE} AND params->>'manifestHash' = ${manifestHash}
    `;
  });
}

/**
 * Acquire the lock for ROLLBACK: takes the xact lock and returns whether a
 * marker for THIS manifest exists (rollback proceeds under the same serialized
 * guard as execute). Rollback deletes the marker itself in its own tx.
 */
export async function withRollbackLock<T>(fn: () => Promise<T>): Promise<T> {
  // Serialize rollback against any concurrent execute via the same xact lock.
  // The lock is released when this claim tx commits; the rollback tx then runs
  // its own FOR UPDATE validation, which is the authoritative concurrency guard.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${BURN_IN_ADVISORY_LOCK_KEY})`;
  });
  return fn();
}

export interface PristineViolation {
  userId: string;
  nickname: string;
  reasons: string[];
}

/**
 * Pristine-state execute gate (finding 1). Burn-in runs ONCE, immediately after
 * roster creation, BEFORE selection activates. Every roster bot must be exactly
 * pristine. A bot is PRISTINE iff ALL hold:
 *   - a ranked_profiles row EXISTS (a MISSING row FAILS — the loader would coerce
 *     null→0 and hide it) and is at SEASON_INITIAL_RP, tier-agnostic, unplaced,
 *     with placement_played/wins/perf/points accumulators and current_win_streak
 *     all zero and last_ranked_match_at NULL
 *   - zero ranked ledger rows; zero ranked user_mode_match_stats games
 *   - zero completed/abandoned match history AND no live/active match
 *   - zero user_xp_events and users.total_xp = 0
 *   - zero user_achievements rows
 *   - no synthetic_bot_reservation; no live (waiting/active) lobby membership
 * Any violation lists the offending reasons. MUST be called under the run lock.
 */
export async function findNonPristineBots(userIds: string[]): Promise<PristineViolation[]> {
  if (userIds.length === 0) return [];
  const rows = await sql<
    Array<{
      user_id: string;
      nickname: string;
      total_xp: number;
      profile_exists: boolean;
      rp: number | null;
      placement_status: string | null;
      placement_played: number | null;
      placement_wins: number | null;
      placement_perf_sum: number | null;
      placement_points_for_sum: number | null;
      placement_points_against_sum: number | null;
      current_win_streak: number | null;
      last_ranked_match_at: string | null;
      games_played: number | null;
      xp_events: number;
      achievements: number;
      reservations: number;
      live_lobbies: number;
      live_matches: number;
      finished_matches: number;
      ranked_ledger: number;
    }>
  >`
    SELECT
      u.id AS user_id,
      u.nickname,
      u.total_xp,
      (rp.user_id IS NOT NULL) AS profile_exists,
      rp.rp, rp.placement_status, rp.placement_played, rp.placement_wins,
      rp.placement_perf_sum, rp.placement_points_for_sum, rp.placement_points_against_sum,
      rp.current_win_streak, rp.last_ranked_match_at,
      COALESCE(ums.games_played, 0) AS games_played,
      (SELECT COUNT(*)::int FROM user_xp_events x WHERE x.user_id = u.id) AS xp_events,
      (SELECT COUNT(*)::int FROM user_achievements a WHERE a.user_id = u.id) AS achievements,
      (SELECT COUNT(*)::int FROM synthetic_bot_reservations r WHERE r.bot_user_id = u.id) AS reservations,
      (SELECT COUNT(*)::int FROM lobby_members lm JOIN lobbies l ON l.id = lm.lobby_id
        WHERE lm.user_id = u.id AND l.status IN ('waiting', 'active')) AS live_lobbies,
      (SELECT COUNT(*)::int FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = u.id AND m.status = 'active') AS live_matches,
      (SELECT COUNT(*)::int FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = u.id AND m.status IN ('completed', 'abandoned')) AS finished_matches,
      (SELECT COUNT(*)::int FROM ranked_rp_changes c WHERE c.user_id = u.id) AS ranked_ledger
    FROM users u
    LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
    LEFT JOIN user_mode_match_stats ums ON ums.user_id = u.id AND ums.mode = 'ranked'
    WHERE u.id = ANY(${userIds}::uuid[])
  `;

  const violations: PristineViolation[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    seen.add(r.user_id);
    const reasons: string[] = [];
    // A MISSING profile fails — a fresh roster bot has one at 450/unplaced.
    if (!r.profile_exists) reasons.push('no ranked_profiles row');
    else {
      if (r.rp !== SEASON_INITIAL_RP) reasons.push(`rp=${r.rp}`);
      if (r.placement_status !== 'unplaced') reasons.push(`placement_status=${r.placement_status}`);
      if ((r.placement_played ?? 0) !== 0) reasons.push(`placement_played=${r.placement_played}`);
      if ((r.placement_wins ?? 0) !== 0) reasons.push(`placement_wins=${r.placement_wins}`);
      if ((r.placement_perf_sum ?? 0) !== 0) reasons.push(`placement_perf_sum=${r.placement_perf_sum}`);
      if ((r.placement_points_for_sum ?? 0) !== 0) reasons.push(`placement_points_for_sum=${r.placement_points_for_sum}`);
      if ((r.placement_points_against_sum ?? 0) !== 0) reasons.push(`placement_points_against_sum=${r.placement_points_against_sum}`);
      if ((r.current_win_streak ?? 0) !== 0) reasons.push(`current_win_streak=${r.current_win_streak}`);
      if (r.last_ranked_match_at != null) reasons.push(`last_ranked_match_at=${r.last_ranked_match_at}`);
    }
    if ((r.games_played ?? 0) !== 0) reasons.push(`ranked_games=${r.games_played}`);
    if (r.ranked_ledger !== 0) reasons.push(`ranked_ledger=${r.ranked_ledger}`);
    if (r.finished_matches !== 0) reasons.push(`finished_matches=${r.finished_matches}`);
    if (r.live_matches !== 0) reasons.push(`live_matches=${r.live_matches}`);
    if (Number(r.total_xp) !== 0) reasons.push(`total_xp=${r.total_xp}`);
    if (r.xp_events !== 0) reasons.push(`xp_events=${r.xp_events}`);
    if (r.achievements !== 0) reasons.push(`achievements=${r.achievements}`);
    if (r.reservations !== 0) reasons.push(`reservations=${r.reservations}`);
    if (r.live_lobbies !== 0) reasons.push(`live_lobbies=${r.live_lobbies}`);
    if (reasons.length > 0) violations.push({ userId: r.user_id, nickname: r.nickname, reasons });
  }
  // A roster id with NO users row at all is also a violation.
  for (const id of userIds) {
    if (!seen.has(id)) violations.push({ userId: id, nickname: '(missing user)', reasons: ['user row not found'] });
  }
  return violations;
}
