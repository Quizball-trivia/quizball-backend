/**
 * Live-DB reads the burn-in engine needs: the persistent roster, the hard
 * ceiling (human top-10 RP), the active category pool, and the one-time
 * burn-in marker guard.
 */
import { sql } from '../../src/db/index.js';
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

// Constant advisory-lock key for the one-time burn-in guard. Any process taking
// pg_advisory_xact_lock(this) around the marker check+insert serializes with
// every other execute attempt, so two concurrent runs can never both pass.
const BURN_IN_ADVISORY_LOCK_KEY = 728_150_100; // mirrors the migration date

/** Has the one-time burn-in already run on this env (any generation)? */
export async function burnInAlreadyRan(): Promise<{ ran: boolean; manifestHash: string | null }> {
  const rows = await sql<{ params: { manifestHash?: string } }[]>`
    SELECT params FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE} LIMIT 1
  `;
  return { ran: rows.length > 0, manifestHash: rows[0]?.params?.manifestHash ?? null };
}

/**
 * Atomically claim the one-time burn-in marker for THIS run manifest. Takes the
 * xact advisory lock, then refuses if any marker already exists. Returns true
 * on success; throws if another run already burned this env in. Finding 9.
 */
export async function claimBurnInMarker(manifestHash: string, seed: number, fixtureCount: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${BURN_IN_ADVISORY_LOCK_KEY})`;
    const existing = await tx<{ params: { manifestHash?: string } }[]>`
      SELECT params FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE} LIMIT 1
    `;
    if (existing.length > 0) {
      const prior = existing[0].params?.manifestHash ?? '(unknown)';
      throw new Error(`burn-in marker already present (manifest ${prior}) — env already burned in`);
    }
    await tx`
      INSERT INTO bot_model_params (params, active, note)
      VALUES (
        ${sql.json({ kind: 'burnin-marker', manifestHash, seed, fixtureCount, completedAt: new Date().toISOString() })},
        false,
        ${BURN_IN_MARKER_NOTE}
      )
    `;
  });
}

export interface PristineViolation {
  userId: string;
  nickname: string;
  reasons: string[];
}

/**
 * Pristine-state execute gate (findings 5/6/1). Burn-in is a pristine-state
 * operation: it runs ONCE, immediately after roster creation, BEFORE selection
 * ever activates. Every roster bot must be exactly: unplaced, RP 450, zero
 * ranked games / XP, no live reservation, no live lobby+match. Returns the list
 * of bots that violate any of these (empty = all pristine).
 *
 * generationCreatedAtFloor gates XP to the roster generation: any user_xp_events
 * row is a violation (a freshly created bot has none).
 */
export async function findNonPristineBots(userIds: string[]): Promise<PristineViolation[]> {
  if (userIds.length === 0) return [];
  const rows = await sql<
    Array<{
      user_id: string;
      nickname: string;
      total_xp: number;
      rp: number | null;
      placement_status: string | null;
      placement_played: number | null;
      games_played: number | null;
      xp_events: number;
      reservations: number;
      live_lobbies: number;
      live_matches: number;
      ranked_ledger: number;
    }>
  >`
    SELECT
      u.id AS user_id,
      u.nickname,
      u.total_xp,
      rp.rp,
      rp.placement_status,
      rp.placement_played,
      COALESCE(ums.games_played, 0) AS games_played,
      (SELECT COUNT(*)::int FROM user_xp_events x WHERE x.user_id = u.id) AS xp_events,
      (SELECT COUNT(*)::int FROM synthetic_bot_reservations r WHERE r.bot_user_id = u.id) AS reservations,
      (SELECT COUNT(*)::int FROM lobby_members lm JOIN lobbies l ON l.id = lm.lobby_id
        WHERE lm.user_id = u.id AND l.status IN ('waiting', 'active')) AS live_lobbies,
      (SELECT COUNT(*)::int FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = u.id AND m.status = 'active') AS live_matches,
      (SELECT COUNT(*)::int FROM ranked_rp_changes c WHERE c.user_id = u.id) AS ranked_ledger
    FROM users u
    LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
    LEFT JOIN user_mode_match_stats ums ON ums.user_id = u.id AND ums.mode = 'ranked'
    WHERE u.id = ANY(${userIds}::uuid[])
  `;

  const violations: PristineViolation[] = [];
  for (const r of rows) {
    const reasons: string[] = [];
    if (r.placement_status != null && r.placement_status !== 'unplaced') reasons.push(`placement_status=${r.placement_status}`);
    if ((r.placement_played ?? 0) !== 0) reasons.push(`placement_played=${r.placement_played}`);
    if (r.rp != null && r.rp !== 450) reasons.push(`rp=${r.rp}`);
    if ((r.games_played ?? 0) !== 0) reasons.push(`ranked_games=${r.games_played}`);
    if (Number(r.total_xp) !== 0) reasons.push(`total_xp=${r.total_xp}`);
    if (r.xp_events !== 0) reasons.push(`xp_events=${r.xp_events}`);
    if (r.reservations !== 0) reasons.push(`reservations=${r.reservations}`);
    if (r.live_lobbies !== 0) reasons.push(`live_lobbies=${r.live_lobbies}`);
    if (r.live_matches !== 0) reasons.push(`live_matches=${r.live_matches}`);
    if (r.ranked_ledger !== 0) reasons.push(`ranked_ledger=${r.ranked_ledger}`);
    if (reasons.length > 0) violations.push({ userId: r.user_id, nickname: r.nickname, reasons });
  }
  return violations;
}
