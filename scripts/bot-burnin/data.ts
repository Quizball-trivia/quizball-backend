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

// pg_advisory_XACT_lock key — held for the DURATION of the single execute (or
// rollback) transaction, so two concurrent runs serialize and a crash releases
// the lock automatically on rollback/disconnect. Transaction-mode Supavisor
// (the pooler) supports xact advisory locks. No session lock, no ownership
// token, no heartbeat — burn-in is NOT resumable, so there is nothing to own
// across a restart.
const BURN_IN_ADVISORY_LOCK_KEY = 728_150_100; // mirrors the migration date

/** One-time marker row stored in bot_model_params.params. */
export interface RunMarker {
  kind: 'burnin-marker';
  manifestHash: string;
  status: 'complete';
  seed: number;
  fixtureCount: number;
  /** The live-derived ceiling the run used — so rollback recomputes the SAME plan. */
  ceilingRp: number;
  completedAt: string;
}

/** Take the xact advisory lock for the current transaction (pooler-safe). */
export async function lockBurnIn(tx: TransactionSql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(${BURN_IN_ADVISORY_LOCK_KEY})`;
}

/** Refuse (throw) if a burn-in marker already exists. Call under the lock. */
export async function assertNotBurnedIn(tx: TransactionSql): Promise<void> {
  const rows = await tx<{ params: RunMarker }[]>`
    SELECT params FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE} LIMIT 1
  `;
  if (rows.length > 0) {
    const m = rows[0].params;
    throw new Error(`ABORT: this environment is already burned in (manifest ${m.manifestHash}, ${m.completedAt}) — refusing.`);
  }
}

/** Insert the one-time 'complete' marker (same tx as the writes). */
export async function insertBurnInMarker(tx: TransactionSql, manifestHash: string, seed: number, fixtureCount: number, ceilingRp: number): Promise<void> {
  const marker: RunMarker = {
    kind: 'burnin-marker', manifestHash, status: 'complete', seed, fixtureCount, ceilingRp,
    completedAt: new Date().toISOString(),
  };
  await tx`
    INSERT INTO bot_model_params (params, active, note)
    VALUES (${sql.json(marker as unknown as Record<string, unknown>)}, false, ${BURN_IN_MARKER_NOTE})
  `;
}

/** Read the burn-in marker (rollback recomputes the plan with its stored ceilingRp). */
export async function readBurnInMarker(): Promise<RunMarker | null> {
  const rows = await sql<{ params: RunMarker }[]>`
    SELECT params FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE} LIMIT 1
  `;
  return rows[0]?.params ?? null;
}

/** Which of the given plan match-ids are already written (idempotent resume). */
export async function existingMatchIds(matchIds: string[]): Promise<Set<string>> {
  if (matchIds.length === 0) return new Set();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM matches WHERE id = ANY(${matchIds}::uuid[])
  `;
  return new Set(rows.map((r) => r.id));
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
export async function findNonPristineBots(tx: TransactionSql, userIds: string[]): Promise<PristineViolation[]> {
  if (userIds.length === 0) return [];
  const rows = await tx<
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
