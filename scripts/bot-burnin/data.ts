/**
 * Live-DB reads the burn-in engine needs: the persistent roster, the hard
 * ceiling (human top-10 RP), the active category pool, and the one-time
 * burn-in marker guard.
 */
import { sql, type TransactionSql } from '../../src/db/index.js';
import { SEASON_INITIAL_RP } from '../../src/modules/ranked/season-rp-formula.js';
import type { BurnInBot, BotSchedule } from './types.js';
import type { SkillBand } from './s2-distribution.js';

const BURN_IN_MARKER_NOTE = 'persistent-bot-burnin:complete';

interface RawScheduleJson {
  activeHours?: unknown;
  sessionMax?: unknown;
  intraSessionGapMin?: unknown;
  band?: unknown;
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

function parseSkillBand(raw: unknown): SkillBand | undefined {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as RawScheduleJson;
  return Number.isInteger(obj.band) && Number(obj.band) >= 0 && Number(obj.band) <= 4
    ? Number(obj.band) as SkillBand
    : undefined;
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
    skillBand: parseSkillBand(r.schedule),
    rp: r.rp ?? 0,
    placementPlayed: r.placement_played ?? 0,
    placementWins: r.placement_wins ?? 0,
    placementStatus: (r.placement_status ?? 'unplaced') as BurnInBot['placementStatus'],
    currentWinStreak: r.current_win_streak ?? 0,
  }));
}

/**
 * Live human top-10 RP for the hard ceiling. HUMANS ONLY (is_ai=false) — the
 * ceiling exists so bots never rank above real players. If 10+ placed humans
 * exist, returns the 10th-highest RP. If 1–9 exist, returns the LOWEST of them
 * (a conservative ceiling below the smallest real human). Returns null ONLY when
 * NO placed human exists (caller then falls back to a conservative absolute cap).
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

// A 'running' marker whose heartbeat/start is older than this is considered a
// dead run and may be taken over by a resume of the SAME manifest.
const RUN_STALE_MS = 60_000;

/** One-time marker row stored in bot_model_params.params. */
export interface RunMarker {
  kind: 'burnin-marker';
  manifestHash: string;
  status: 'running' | 'complete';
  /** Random per-process id; every subsequent chunk re-checks it (fail-closed). */
  runId: string;
  seed: number;
  fixtureCount: number;
  /** The live-derived ceiling the run used — so rollback recomputes the SAME plan. */
  ceilingRp: number;
  startedAt: string;
  /** Bumped each chunk so a live run isn't mistaken for stale (resume takeover). */
  heartbeatAt: string;
  completedAt?: string;
}

function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Take the xact advisory lock for the current transaction (pooler-safe). */
export async function lockBurnIn(tx: TransactionSql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(${BURN_IN_ADVISORY_LOCK_KEY})`;
}

/**
 * FOR UPDATE-lock the roster bots' rows in EVERY table the pristine gate reads
 * (P3): users (total_xp/coins), ranked_profiles, ranked stats, achievements, and
 * xp events — so no concurrent write can change a gate-checked fact between the
 * check and the writes. (matches/lobbies/reservations aren't roster-PK-keyed;
 * burn-in runs pre-flag with no live selection, so this is defense-in-depth.)
 */
export async function lockRosterGateRows(tx: TransactionSql, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await tx`SELECT id FROM users WHERE id = ANY(${userIds}::uuid[]) FOR UPDATE`;
  await tx`SELECT user_id FROM ranked_profiles WHERE user_id = ANY(${userIds}::uuid[]) FOR UPDATE`;
  await tx`SELECT user_id FROM user_mode_match_stats WHERE user_id = ANY(${userIds}::uuid[]) FOR UPDATE`;
  await tx`SELECT user_id FROM user_achievements WHERE user_id = ANY(${userIds}::uuid[]) FOR UPDATE`;
  await tx`SELECT user_id FROM user_xp_events WHERE user_id = ANY(${userIds}::uuid[]) FOR UPDATE`;
}

export class RunClaimError extends Error {}

/**
 * Claim the run in the FIRST chunk's tx (under the advisory lock). Inserts a
 * durable 'running' marker with OUR runId, so concurrent --execute runs that
 * interleave between chunks are blocked even though the advisory lock is
 * released on each chunk commit. Decision (all under the lock):
 *   - no marker                        → claim (insert 'running' + our runId)
 *   - 'complete'                       → refuse (already burned in)
 *   - 'running' + different manifest   → refuse (a different run holds it)
 *   - 'running' + same manifest, fresh → refuse (a concurrent live run of this
 *                                        plan is in progress)
 *   - 'running' + same manifest, STALE → take over (crashed run; this is a
 *                                        resume — idempotent skip handles dupes)
 * Returns our runId (passed to every later chunk's re-check).
 */
export async function claimRunning(tx: TransactionSql, manifestHash: string, seed: number, ceilingRp: number): Promise<string> {
  const rows = await tx<{ params: RunMarker }[]>`
    SELECT params FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE} LIMIT 1
  `;
  const now = new Date().toISOString();
  if (rows.length === 0) {
    const runId = newRunId();
    const marker: RunMarker = {
      kind: 'burnin-marker', manifestHash, status: 'running', runId, seed, fixtureCount: 0, ceilingRp,
      startedAt: now, heartbeatAt: now,
    };
    await tx`
      INSERT INTO bot_model_params (params, active, note)
      VALUES (${sql.json(marker as unknown as Record<string, unknown>)}, false, ${BURN_IN_MARKER_NOTE})
    `;
    return runId;
  }
  const m = rows[0].params;
  if (m.status === 'complete') {
    throw new RunClaimError(`ABORT: this environment is already burned in (manifest ${m.manifestHash}, ${m.completedAt ?? '?'}) — refusing.`);
  }
  if (m.manifestHash !== manifestHash) {
    throw new RunClaimError(`ABORT: a DIFFERENT burn-in run is in progress (manifest ${m.manifestHash}, runId ${m.runId}) — refusing.`);
  }
  const ageMs = Date.now() - new Date(m.heartbeatAt ?? m.startedAt).getTime();
  if (ageMs < RUN_STALE_MS) {
    throw new RunClaimError(`ABORT: a concurrent live run of this plan is in progress (heartbeat ${Math.round(ageMs / 1000)}s ago) — refusing.`);
  }
  // Stale same-manifest run → take it over (resume). New runId invalidates the old.
  const runId = newRunId();
  await tx`
    UPDATE bot_model_params
    SET params = params || ${sql.json({ runId, heartbeatAt: now, ceilingRp })}
    WHERE note = ${BURN_IN_MARKER_NOTE}
  `;
  return runId;
}

/**
 * Re-assert our claim in a later chunk's tx (under the lock). Fail-closed: if the
 * marker is gone, no longer 'running', or held by a DIFFERENT runId (a takeover),
 * abort — this chunk's writes must not land. Bumps the heartbeat.
 */
export async function assertRunClaim(tx: TransactionSql, manifestHash: string, runId: string): Promise<void> {
  const rows = await tx<{ params: RunMarker }[]>`
    SELECT params FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE} LIMIT 1
  `;
  const m = rows[0]?.params;
  if (!m || m.status !== 'running' || m.manifestHash !== manifestHash || m.runId !== runId) {
    throw new RunClaimError(`ABORT: burn-in run claim lost (marker runId ${m?.runId ?? 'none'}/${m?.status ?? 'gone'} != ${runId}) — aborting fail-closed.`);
  }
  await tx`
    UPDATE bot_model_params SET params = params || ${sql.json({ heartbeatAt: new Date().toISOString() })}
    WHERE note = ${BURN_IN_MARKER_NOTE}
  `;
}

/** Flip the marker 'running' → 'complete' in the FINAL chunk's tx (verifies our claim). */
export async function completeRun(tx: TransactionSql, manifestHash: string, runId: string, fixtureCount: number): Promise<void> {
  await assertRunClaim(tx, manifestHash, runId);
  await tx`
    UPDATE bot_model_params
    SET params = params || ${sql.json({ status: 'complete', fixtureCount, completedAt: new Date().toISOString() })}
    WHERE note = ${BURN_IN_MARKER_NOTE}
  `;
}

/** Read the burn-in marker (rollback recomputes the plan with its stored ceilingRp). */
export async function readBurnInMarker(): Promise<RunMarker | null> {
  const rows = await sql<{ params: RunMarker }[]>`
    SELECT params FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE} LIMIT 1
  `;
  return rows[0]?.params ?? null;
}

/** Minimal fixture shape the resume validator checks against the DB. */
export interface ResumeFixture {
  matchId: string;
  key: string;
  botAUserId: string;
  botBUserId: string;
  decision: string;
  endedAt: Date;
}

/**
 * Resume validation (P2): for each planned fixture whose match row already
 * exists, VERIFY it is genuinely OURS before treating it as done — the row must
 * be a completed burn-in match (ranked_context.burnIn === true + our fixtureKey),
 * with the exact planned participant pair, decision, and ended_at. Any mismatch
 * (a colliding non-burn-in match at this id, or a partially-written/foreign row)
 * throws — it must NEVER be silently accepted as complete. Returns the set of
 * VALIDATED already-done match ids.
 */
export async function validatedExistingMatchIds(fixtures: ResumeFixture[]): Promise<Set<string>> {
  const done = new Set<string>();
  const matchIds = fixtures.map((f) => f.matchId);
  if (matchIds.length === 0) return done;

  const rows = await sql<
    { id: string; status: string; winner_user_id: string | null; ended_at: string | null; decision: string | null; burn_in: boolean | null; fixture_key: string | null }[]
  >`
    SELECT
      m.id, m.status, m.winner_user_id, m.ended_at,
      m.state_payload->>'winnerDecisionMethod' AS decision,
      (m.ranked_context->>'burnIn')::boolean AS burn_in,
      m.ranked_context->>'fixtureKey' AS fixture_key
    FROM matches m WHERE m.id = ANY(${matchIds}::uuid[])
  `;
  const byId = new Map(rows.map((r) => [r.id, r]));

  const players = await sql<{ match_id: string; user_id: string; seat: number }[]>`
    SELECT match_id, user_id, seat FROM match_players WHERE match_id = ANY(${matchIds}::uuid[])
  `;
  const playersByMatch = new Map<string, { user_id: string; seat: number }[]>();
  for (const p of players) {
    const list = playersByMatch.get(p.match_id) ?? [];
    list.push(p);
    playersByMatch.set(p.match_id, list);
  }

  for (const f of fixtures) {
    const m = byId.get(f.matchId);
    if (!m) continue; // not written yet — will be created this run
    const fail = (why: string): never => {
      throw new Error(`resume abort: match ${f.matchId} ${why} — a colliding/foreign or partially-written match must not be accepted as complete.`);
    };
    if (m.burn_in !== true) fail('is not a burn-in match (ranked_context.burnIn !== true)');
    if (m.fixture_key !== f.key) fail(`fixtureKey mismatch (db=${m.fixture_key})`);
    if (m.status !== 'completed') fail(`status is '${m.status}', not 'completed' (partial write)`);
    if (m.winner_user_id === null) fail('winner_user_id is null');
    if (m.decision !== f.decision) fail(`decision mismatch (db=${m.decision})`);
    if (m.ended_at == null || new Date(m.ended_at).toISOString() !== f.endedAt.toISOString()) fail('ended_at mismatch');
    const pl = (playersByMatch.get(f.matchId) ?? []).sort((a, b) => a.seat - b.seat);
    const seatA = pl.find((p) => p.seat === 1);
    const seatB = pl.find((p) => p.seat === 2);
    if (seatA?.user_id !== f.botAUserId || seatB?.user_id !== f.botBUserId) fail('participant pair mismatch');
    done.add(f.matchId);
  }
  return done;
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
