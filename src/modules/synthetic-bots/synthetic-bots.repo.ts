import { sql, type TransactionSql } from '../../db/index.js';
import { withSpan } from '../../core/tracing.js';

/**
 * Pure-data repo for the persistent-bot roster tables:
 *   synthetic_bot_reservations  one-concurrent-match invariant (lobby-keyed, fenced)
 *   synthetic_player_profiles   hidden ability + identity + activity schedule
 *
 * All reads/writes are inert until the roster ships (PR5). PR7 only reads the
 * roster and drives the reservation lifecycle; the schema (PR1) already exists
 * on every env, so an empty roster is a no-op selection, not an error.
 *
 * Concurrency contract (see PERSISTENT-BOTS-PLAN §1.7 + Appendix A):
 *   - acquire is INSERT ... ON CONFLICT (bot_user_id) DO NOTHING — exactly one
 *     winner under a concurrent race; the loser gets null and falls back.
 *   - transfer sets match_id in the SAME transaction as match creation.
 *   - release is owner-qualified (holder + fence): a stale holder can never
 *     release a reservation the bot has since re-acquired under a newer fence.
 *   - terminal teardown sites that only know the lobby/match id release by
 *     lobby/match (any holder) — the reservation is being torn down, not
 *     handed off, so the fence guard would only strand it for the TTL.
 */

export interface SyntheticBotReservationRow {
  bot_user_id: string;
  lobby_id: string;
  match_id: string | null;
  holder: string;
  fence: number;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
  committed_at: string | null;
}

export interface SyntheticPlayerProfileRow {
  user_id: string;
  status: 'active' | 'resting' | 'retired' | string;
  base_skill: number;
  consistency: number;
  speed_offset: number;
  category_affinities: unknown;
  schedule: unknown;
  daily_cap: number;
  matches_today: number;
  matches_day: string | null;
  home_city: string | null;
  home_lat: number | null;
  home_lng: number | null;
  favorite_club: string | null;
  rename_propensity: number;
  personality_seed: number;
  governor_adjustment: number;
  winrate_ema: number | null;
  winrate_samples: number;
  governor_updated_at: string | null;
  last_selected_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A roster bot joined with the ranked profile fields selection reads. */
export interface EligibleBotRow extends SyntheticPlayerProfileRow {
  rp: number;
  tier: string;
  placement_status: string;
  nickname: string | null;
  avatar_url: string | null;
  avatar_customization: unknown;
  country: string | null;
}

/** A roster bot the rename worker may consider this tick. */
export interface RenameCandidateRow {
  user_id: string;
  schedule: unknown;
  rename_propensity: number;
  personality_seed: string | number;
  nickname: string | null;
}

export const syntheticBotsRepo = {
  /**
   * Acquire a reservation for one roster bot. INSERT ... ON CONFLICT DO NOTHING
   * on the bot_user_id PK: if another selection already holds this bot (or it
   * holds a live reservation from a prior lobby), the insert returns no row and
   * the caller moves on to the next candidate. Returns the fresh fence on a win.
   *
   * The INSERT ... SELECT re-checks status + selection_frozen INSIDE the write
   * (PR10). Eligibility was read earlier in the selection pass, so a bare
   * VALUES insert left a TOCTOU window: an operator could freeze a misbehaving
   * bot, the freeze would commit, and a selection already holding the stale row
   * could still reserve and launch that bot. Re-checking here makes the freeze
   * effective against in-flight selections, not just future ones.
   */
  async acquireReservation(params: {
    botUserId: string;
    lobbyId: string;
    holder: string;
    expiresAt: Date;
  }): Promise<SyntheticBotReservationRow | null> {
    const [row] = await sql<SyntheticBotReservationRow[]>`
      INSERT INTO synthetic_bot_reservations (bot_user_id, lobby_id, holder, expires_at)
      SELECT ${params.botUserId}, ${params.lobbyId}, ${params.holder}, ${params.expiresAt}
      FROM synthetic_player_profiles p
      WHERE p.user_id = ${params.botUserId}
        AND p.status = 'active'
        AND NOT p.selection_frozen
      ON CONFLICT (bot_user_id) DO NOTHING
      RETURNING *
    `;
    return row ?? null;
  },

  /**
   * Transfer a lobby-keyed reservation onto its match, atomically with match
   * creation (caller passes the SAME tx that inserted the match row). Guarded on
   * lobby_id + match_id IS NULL so a re-acquired reservation (different lobby) or
   * an already-transferred one is never clobbered. Returns the updated row, or
   * null if nothing matched (no reservation for this lobby — the common
   * ephemeral case, or a race the caller treats as "not persistent").
   */
  async transferReservationToMatch(
    tx: TransactionSql,
    params: { botUserId: string; lobbyId: string; matchId: string },
  ): Promise<SyntheticBotReservationRow | null> {
    const rows = await tx.unsafe<SyntheticBotReservationRow[]>(
      `UPDATE synthetic_bot_reservations
         SET match_id = $1, heartbeat_at = now()
       WHERE bot_user_id = $2 AND lobby_id = $3 AND match_id IS NULL
       RETURNING *`,
      [params.matchId, params.botUserId, params.lobbyId],
    );
    return rows[0] ?? null;
  },

  // NOTE: there is deliberately NO unlocked lobby-keyed release method. Every
  // lobby-phase release (match_id IS NULL, lobby possibly still pre-draft) MUST go
  // through abortRankedAiLobbyLocked below, which serializes with draft activation
  // via the shared advisory lock. A bare `DELETE ... WHERE lobby_id = ...` would
  // race `setLobbyStatus(...,'active')` under READ COMMITTED (Sol P1-2).

  /**
   * Take the per-lobby advisory xact lock inside a CALLER-OWNED transaction. Used
   * by the persistent-bot match-creation tx (matchesService.createMatchFromLobby)
   * as its FIRST statement, so match creation + reservation transfer share the
   * TOTAL ORDER with the draft activation and the reservation abort — all of which
   * take `pg_advisory_xact_lock(hashtext('ranked_ai_lobby:'||lobbyId))` first,
   * before any row lock. Consistent lock ordering → no deadlock; the abort's
   * in-lock EXISTS(active match) check and this tx's match insert can never
   * interleave into a split state (match created + lobby torn down).
   */
  async takeLobbyAdvisoryLockTx(tx: TransactionSql, lobbyId: string): Promise<void> {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('ranked_ai_lobby:' || $1))`, [lobbyId]);
  },

  /**
   * ACTIVATION half of the abort/activate ordering. Under the per-lobby advisory
   * lock, in ONE transaction: flip the lobby to 'active' AND mark any persistent-
   * bot reservation for this lobby as COMMITTED (committed_at = now()).
   *
   * committed_at is the durable "a draft has started for this bot — hands off"
   * fact ON THE RESERVATION. It survives past commit (the lock is released here,
   * but match creation is a much later, separate transaction), so an abort that
   * takes the lock during the activate → draft → transfer gap sees committed_at
   * set and no-ops — WITHOUT relying on lobby status or the match row existing yet
   * (the true root cause of the earlier race). A genuine draft-teardown clears it
   * again (abortRankedAiLobbyLocked with uncommitFirst) as part of its abort.
   *
   * Returns:
   *   - activated: whether the lobby row was flipped to 'active' (false if gone).
   *   - committedReservation: whether THIS CALL transitioned a reservation's
   *     committed_at NULL→now() (i.e. THIS flow owns the commit). The
   *     `WHERE committed_at IS NULL` guard means exactly one concurrent activator
   *     sees the affected row — so a caller can pass draftTeardown/uncommitFirst
   *     ONLY when committedReservation is true, never clearing a commit made by a
   *     racing reconnect flow (the residual case-(a) race the live-match check
   *     alone could not close).
   */
  async activateLobbyForDraftLocked(
    lobbyId: string,
  ): Promise<{ activated: boolean; committedReservation: boolean }> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('ranked_ai_lobby:' || $1))`, [lobbyId]);
      const rows = await tx.unsafe<{ id: string }[]>(
        `UPDATE lobbies SET status = 'active', updated_at = NOW() WHERE id = $1 RETURNING id`,
        [lobbyId],
      );
      // Commit any lobby-keyed reservation to THIS draft. No-op if none (ephemeral
      // opponent) or already transferred/committed by a racing flow. The RETURNING
      // row count proves whether THIS call owns the commit.
      const committed = await tx.unsafe<{ bot_user_id: string }[]>(
        `UPDATE synthetic_bot_reservations
            SET committed_at = now()
          WHERE lobby_id = $1 AND match_id IS NULL AND committed_at IS NULL
          RETURNING bot_user_id`,
        [lobbyId],
      );
      return { activated: rows.length > 0, committedReservation: committed.length > 0 };
    });
  },

  /**
   * ABORT half of the lock ordering, and the ONLY lobby-phase reservation-release
   * path. Under the SAME per-lobby advisory lock as draft activation, the
   * AUTHORITATIVE gate on whether the bot may be reclaimed is a DYNAMIC in-lock
   * live-match check — NOT the caller's static teardown-intent flag. Whether an
   * abort is safe depends on the race that actually happened (did a reconnect
   * activate + create a match between this handler starting and its abort), which
   * only an in-lock check can decide.
   *
   * Inside the locked tx:
   *   1. If an ACTIVE match exists for the lobby → the bot is committed to a LIVE
   *      match → NO-OP entirely (never clear committed_at, never release, never
   *      teardown). This overrides any teardown-intent: a stale draft_start_error
   *      / ticket-failure / sweeper that lost the race cannot clobber the fresh
   *      commit a reconnect just created.
   *   2. Else (no active match): if the caller has teardown-intent (uncommitFirst)
   *      clear committed_at — safe now, because there is no live match. Then free
   *      the still-lobby-keyed reservation ONLY if committed_at IS NULL (a commit
   *      left over from an in-flight activation with no match yet, and NO
   *      teardown-intent, is still protected), and end the lobby.
   *
   * A transferred reservation (match_id set) is never freed here (its terminal
   * fate is the settlement-gated by-match path).
   *
   * getActiveMatchForLobby's equivalent is a plain SELECT (acquires no locks), so
   * evaluating it inside the advisory-locked tx introduces no lock-ordering risk.
   *
   * Redis/socket cleanup is left to the caller (idempotent, outside the tx).
   */
  async abortRankedAiLobbyLocked(
    lobbyId: string,
    opts?: { uncommitFirst?: boolean },
  ): Promise<{ aborted: boolean; botReleased: string | null; lobbyDeleted: boolean; removedMemberIds: string[] }> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('ranked_ai_lobby:' || $1))`, [lobbyId]);

      // AUTHORITATIVE dynamic gate: an active match for the lobby means the bot is
      // committed to a LIVE match (a reconnect may have activated + created it
      // between this handler starting and now). Hands off entirely — overrides
      // any static teardown-intent.
      const [{ has_active_match }] = await tx.unsafe<{ has_active_match: boolean }[]>(
        `SELECT EXISTS (
           SELECT 1 FROM matches m WHERE m.lobby_id = $1 AND m.status = 'active'
         ) AS has_active_match`,
        [lobbyId],
      );
      if (has_active_match) {
        return { aborted: false, botReleased: null, lobbyDeleted: false, removedMemberIds: [] };
      }

      // No live match. A teardown-intent caller may now clear committed_at — safe,
      // because nothing live owns the bot. (Without teardown-intent, a leftover
      // commit stays and protects the still-in-flight activation below.)
      if (opts?.uncommitFirst) {
        await tx.unsafe(
          `UPDATE synthetic_bot_reservations SET committed_at = NULL
            WHERE lobby_id = $1 AND match_id IS NULL`,
          [lobbyId],
        );
      }

      // A still-COMMITTED, still-lobby-keyed reservation (a caller without
      // teardown-intent, e.g. a plain cancel that lost to a fresh activation) →
      // hands off (do not release, do not teardown).
      const committed = await tx.unsafe<{ bot_user_id: string }[]>(
        `SELECT bot_user_id FROM synthetic_bot_reservations
          WHERE lobby_id = $1 AND match_id IS NULL AND committed_at IS NOT NULL`,
        [lobbyId],
      );
      if (committed.length > 0) {
        return { aborted: false, botReleased: null, lobbyDeleted: false, removedMemberIds: [] };
      }
      const [lobby] = await tx.unsafe<{ id: string }[]>(
        `SELECT id FROM lobbies WHERE id = $1`,
        [lobbyId],
      );
      // Free the reservation only while still lobby-keyed AND uncommitted. A
      // transferred (match_id set) or committed reservation is left untouched.
      const [freed] = await tx.unsafe<{ bot_user_id: string }[]>(
        `DELETE FROM synthetic_bot_reservations
          WHERE lobby_id = $1 AND match_id IS NULL AND committed_at IS NULL
          RETURNING bot_user_id`,
        [lobbyId],
      );
      // End the lobby: remove all members (so the bot is definitively no longer a
      // member of any lobby that could be activated), then delete the lobby row.
      let removedMemberIds: string[] = [];
      let lobbyDeleted = false;
      if (lobby) {
        const removed = await tx.unsafe<{ user_id: string }[]>(
          `DELETE FROM lobby_members WHERE lobby_id = $1 RETURNING user_id`,
          [lobbyId],
        );
        removedMemberIds = removed.map((r) => r.user_id);
        await tx.unsafe(`DELETE FROM lobbies WHERE id = $1`, [lobbyId]);
        lobbyDeleted = true;
      }
      return { aborted: true, botReleased: freed?.bot_user_id ?? null, lobbyDeleted, removedMemberIds };
    });
  },

  /**
   * Terminal release keyed by match (any holder). The match reached a terminal
   * state (completion after settlement, forfeit, disconnect, orphan, sweep).
   */
  async releaseReservationByMatch(matchId: string): Promise<string | null> {
    const rows = await sql<{ bot_user_id: string }[]>`
      DELETE FROM synthetic_bot_reservations
      WHERE match_id = ${matchId}
      RETURNING bot_user_id
    `;
    return rows[0]?.bot_user_id ?? null;
  },

  /**
   * Re-key a stranded lobby-keyed reservation onto its live match (sweeper
   * recovery for a crash between match creation and transfer). Never touches a
   * reservation that already carries a match_id.
   *
   * Bot-qualified: only re-keys when the reserved bot is actually a match_player
   * of the target match (no one-match-per-lobby constraint exists, so a
   * duplicate-creation state could otherwise re-key onto the wrong match). The
   * fence guard (`fence = expectedFence`) ensures a stale sweep snapshot cannot
   * mutate a newer, re-acquired reservation. Returns whether a row was re-keyed.
   */
  async rekeyReservationToMatch(params: {
    botUserId: string;
    lobbyId: string;
    matchId: string;
    expectedFence: number;
  }): Promise<boolean> {
    const rows = await sql<{ bot_user_id: string }[]>`
      UPDATE synthetic_bot_reservations
        SET match_id = ${params.matchId},
            heartbeat_at = now(),
            expires_at = now() + interval '180 seconds'
      WHERE bot_user_id = ${params.botUserId}
        AND lobby_id = ${params.lobbyId}
        AND fence = ${params.expectedFence}
        AND match_id IS NULL
        AND EXISTS (
          SELECT 1 FROM match_players mp
          WHERE mp.match_id = ${params.matchId} AND mp.user_id = ${params.botUserId}
        )
      RETURNING bot_user_id
    `;
    return rows.length > 0;
  },

  /**
   * Fence-qualified heartbeat/expiry extension. Only extends the reservation the
   * sweep observed (fence match), so a stale snapshot cannot extend a newer
   * re-acquired reservation. Returns whether a row was extended.
   */
  async heartbeatReservationFenced(params: {
    botUserId: string;
    expectedFence: number;
    expiresAt: Date;
  }): Promise<boolean> {
    const rows = await sql<{ bot_user_id: string }[]>`
      UPDATE synthetic_bot_reservations
        SET heartbeat_at = now(), expires_at = ${params.expiresAt}
      WHERE bot_user_id = ${params.botUserId} AND fence = ${params.expectedFence}
      RETURNING bot_user_id
    `;
    return rows.length > 0;
  },

  /** Whether a lobby is still live enough to keep a pre-match reservation alive. */
  async lobbyHasMembers(lobbyId: string): Promise<boolean> {
    const [row] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM lobby_members WHERE lobby_id = ${lobbyId}
    `;
    return (row?.n ?? 0) > 0;
  },

  /**
   * Whether a match-keyed reservation is SAFE to release for a SPECIFIC bot —
   * proven by direct facts, never by age. Settlement supports PARTIAL ledgers
   * (PR2 recovery: a human's ranked_rp_changes row can land before the bot's),
   * so a match-wide "any ledger row exists" check is a false positive. We check
   * the BOT'S OWN row. Safe iff:
   *   - the match row is gone (nothing left to settle), OR
   *   - a ranked_rp_changes row exists FOR THIS BOT (its RP committed), OR
   *   - the match is 'abandoned' (no-contest / terminal abandon — no RP settles).
   * An 'active' match, or a 'completed' match whose bot ledger row hasn't landed
   * yet, is NOT safe (the bot's settlement may still be in flight).
   */
  async isMatchReservationSafeToRelease(matchId: string, botUserId: string): Promise<boolean> {
    const [row] = await sql<{ status: string | null; bot_settled: boolean }[]>`
      SELECT
        m.status AS status,
        EXISTS (
          SELECT 1 FROM ranked_rp_changes rc
          WHERE rc.match_id = m.id AND rc.user_id = ${botUserId}
        ) AS bot_settled
      FROM matches m
      WHERE m.id = ${matchId}
    `;
    if (!row) return true; // match row gone → nothing to settle, safe to free.
    if (row.bot_settled) return true; // this bot's ledger row committed.
    if (row.status === 'abandoned') return true; // no-contest / terminal abandon.
    return false; // active, or completed-but-bot-unsettled → still in flight.
  },

  /**
   * Atomic, settlement-gated release keyed by match. Deletes the reservation for
   * `matchId` ONLY when that bot's settlement is provably done — the bot's own
   * ranked_rp_changes row exists, OR the match is 'abandoned' (no-contest), OR
   * the match row is gone. This is the SINGLE choke point every terminal release
   * site (completion, forfeit, disconnect, orphan, sweeper) routes through, so a
   * caught-and-swallowed settlement failure can never free the bot early. Uses
   * the reservation's own bot_user_id (no caller need know it). The predicate is
   * evaluated inside the DELETE, so it is race-free w.r.t. a concurrent
   * settlement commit. Returns the freed bot id (if released) else null.
   */
  async releaseReservationByMatchIfSettled(matchId: string): Promise<string | null> {
    const rows = await sql<{ bot_user_id: string }[]>`
      DELETE FROM synthetic_bot_reservations r
      WHERE r.match_id = ${matchId}
        AND (
          NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = r.match_id)
          OR EXISTS (
            SELECT 1 FROM ranked_rp_changes rc
            WHERE rc.match_id = r.match_id AND rc.user_id = r.bot_user_id
          )
          OR EXISTS (
            SELECT 1 FROM matches m WHERE m.id = r.match_id AND m.status = 'abandoned'
          )
        )
      RETURNING r.bot_user_id
    `;
    return rows[0]?.bot_user_id ?? null;
  },

  /** Reservations past their expiry, oldest first — the sweeper's work list. */
  async listExpiredReservations(now: Date, limit: number): Promise<SyntheticBotReservationRow[]> {
    return sql<SyntheticBotReservationRow[]>`
      SELECT * FROM synthetic_bot_reservations
      WHERE expires_at < ${now}
      ORDER BY expires_at ASC
      LIMIT ${limit}
    `;
  },

  /** Extend a live reservation's heartbeat/expiry (kept alive across a match). */
  async heartbeatReservation(params: { botUserId: string; expiresAt: Date }): Promise<void> {
    await sql`
      UPDATE synthetic_bot_reservations
        SET heartbeat_at = now(), expires_at = ${params.expiresAt}
      WHERE bot_user_id = ${params.botUserId}
    `;
  },

  async getReservationByBot(botUserId: string): Promise<SyntheticBotReservationRow | null> {
    const [row] = await sql<SyntheticBotReservationRow[]>`
      SELECT * FROM synthetic_bot_reservations WHERE bot_user_id = ${botUserId}
    `;
    return row ?? null;
  },

  /**
   * Eligible roster bots for selection, joined to their ranked profile + user
   * identity. HARD filters applied in SQL (never relaxed): status='active', not
   * currently reserved (no reservation row). SOFT constraints (recently-faced,
   * daily cap, schedule) are applied in the selection service so the relaxation
   * ladder can widen without another round trip.
   *
   * Returns every active, unreserved bot with its real RP/tier/identity; the
   * roster is ~1,000 rows so a full scan per selection is acceptable and avoids
   * per-band query churn. Empty roster → empty array → ephemeral fallback.
   */
  async listEligibleBots(): Promise<EligibleBotRow[]> {
    return withSpan('db.synthetic_bots.list_eligible', {
      'db.operation.name': 'select',
    }, async () => {
      return sql<EligibleBotRow[]>`
        SELECT
          p.*,
          rp.rp AS rp,
          rp.tier AS tier,
          rp.placement_status AS placement_status,
          u.nickname AS nickname,
          u.avatar_url AS avatar_url,
          u.avatar_customization AS avatar_customization,
          u.country AS country
        FROM synthetic_player_profiles p
        JOIN users u ON u.id = p.user_id
        -- INNER JOIN: a persistent bot without a ranked_profile has no RP and
        -- cannot be RP-matched — exclude it (EligibleBotRow.rp is non-null). Every
        -- roster bot gets a profile at generation (PR5) + settlement (PR2); this is
        -- a defensive guard against a NULL rp that would NaN the nearest-RP sort.
        JOIN ranked_profiles rp ON rp.user_id = p.user_id
        WHERE p.status = 'active'
          -- Operator freeze (PR10). A HARD constraint, deliberately alongside
          -- status/reservation rather than in the relaxation ladder: an operator
          -- freezing a misbehaving bot must never be undone by the ladder
          -- widening when the eligible pool runs thin.
          AND NOT p.selection_frozen
          AND u.ai_kind = 'persistent'
          AND NOT EXISTS (
            SELECT 1 FROM synthetic_bot_reservations r WHERE r.bot_user_id = p.user_id
          )
      `;
    });
  },

  /**
   * Roster bots that could plausibly rename right now, for the rename worker.
   *
   * HARD filters in SQL:
   *   - persistent + active (a retired/resting bot does not fiddle with its
   *     handle; a non-persistent AI has no public identity to evolve)
   *   - rename_propensity > 0 — the per-bot lifetime propensity assigned at
   *     generation, which is what makes only ~10-15% of the roster ever rename
   *   - NOT currently reserved — a rename must never land mid-match, where the
   *     opponent would watch their rival's name change between questions
   *   - a non-empty current nickname to evolve from
   *
   * The 2-free/30-day quota is NOT filtered here: it is enforced authoritatively
   * inside `changeNicknameInTx`, and duplicating it as a scan predicate would
   * let the two drift apart. Bots that are out of quota simply come back gated.
   *
   * A MINIMUM RENAME INTERVAL is filtered here, and it is load-bearing for
   * multi-replica safety. Every replica runs this worker, and the per-tick draw
   * is hash-deterministic — so on a firing hour EVERY replica draws true for the
   * same bot and would each call changeNicknameInTx. While the bot still has
   * free allowance the SQL quota gate accepts all of them, producing several
   * nickname_history rows minutes apart: both a wasted allowance and a visible
   * tell (no human renames three times in one hour). Excluding any bot that
   * already renamed recently collapses that to at most one rename per window,
   * whatever the replica count. `changed_by = 'user'` matches the rows this
   * worker writes and the ones a human write would produce.
   */
  async listRenameCandidates(limit = 1000): Promise<RenameCandidateRow[]> {
    return sql<RenameCandidateRow[]>`
      SELECT
        p.user_id,
        p.schedule,
        p.rename_propensity,
        p.personality_seed,
        u.nickname
      FROM synthetic_player_profiles p
      JOIN users u ON u.id = p.user_id
      WHERE p.status = 'active'
        AND u.ai_kind = 'persistent'
        AND p.rename_propensity > 0
        AND u.nickname IS NOT NULL
        AND length(btrim(u.nickname)) > 0
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM synthetic_bot_reservations r WHERE r.bot_user_id = p.user_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM nickname_history nh
          WHERE nh.user_id = p.user_id
            AND nh.changed_at > NOW() - INTERVAL '30 days'
        )
      LIMIT ${limit}
    `;
  },

  /**
   * Atomically rename a roster bot, or refuse.
   *
   * WHY THIS EXISTS RATHER THAN A CHECK FOLLOWED BY changeNicknameInTx: the
   * candidate scan's predicates are a snapshot taken at the top of the tick,
   * and the write lands seconds later after the name-generation round trips. A
   * separate re-check before the write only NARROWS that window — two replicas
   * can both pass the check before either writes (duplicate counted history), or
   * a reservation can be acquired in between (rename lands mid-match, changing
   * the name under a live opponent).
   *
   * So the preconditions and the write share ONE transaction, with the users row
   * locked FIRST — the same lock changeNicknameInTx takes, which is what
   * serializes concurrent renames of this bot across replicas. Once the lock is
   * held, the two NOT EXISTS checks are evaluated against a state no one else
   * can be mutating, and the loser of a race sees the winner's committed
   * nickname_history row and backs off.
   *
   * The human quota gate is re-implemented here identically to
   * users.repo.changeNicknameInTx (counted rows < FREE, else 30-day cooldown) so
   * a bot faces exactly the allowance a human faces, and the history row it
   * writes is byte-identical: changed_by='user', counted=true,
   * identity_derived=false.
   *
   * Returns 'renamed' | 'raced' | 'quota_gated'.
   */
  async renameBotAtomically(params: {
    botUserId: string;
    oldNickname: string | null;
    newNickname: string;
    freeChanges: number;
    cooldownDays: number;
  }): Promise<'renamed' | 'raced' | 'quota_gated'> {
    const { botUserId, oldNickname, newNickname, freeChanges, cooldownDays } = params;
    return sql.begin(async (tx: TransactionSql) => {
      // Same lock, taken first, as the human rename path — this is what makes
      // the checks below race-free against another replica's rename.
      await tx.unsafe(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [botUserId]);

      const [guard] = await tx.unsafe<{ eligible: boolean }[]>(
        `SELECT NOT EXISTS (
           SELECT 1 FROM synthetic_bot_reservations r WHERE r.bot_user_id = $1
         ) AND NOT EXISTS (
           SELECT 1 FROM nickname_history nh
           WHERE nh.user_id = $1
             AND nh.changed_at > NOW() - ($2::int * INTERVAL '1 day')
         ) AS eligible`,
        [botUserId, cooldownDays]
      );
      if (guard?.eligible !== true) return 'raced';

      const gated = await tx.unsafe<{ id: string }[]>(
        `INSERT INTO nickname_history
           (user_id, old_nickname, new_nickname, changed_by, counted, identity_derived)
         SELECT $1, $2, $3, 'user', true, false
         WHERE (SELECT count(*) FROM nickname_history WHERE user_id = $1 AND counted) < $4
            OR (SELECT max(changed_at) FROM nickname_history WHERE user_id = $1 AND counted)
               <= now() - ($5::int * INTERVAL '1 day')
         RETURNING id`,
        [botUserId, oldNickname, newNickname, freeChanges, cooldownDays]
      );
      if (gated.length === 0) return 'quota_gated';

      await tx.unsafe(`UPDATE users SET nickname = $2, updated_at = NOW() WHERE id = $1`, [
        botUserId,
        newNickname,
      ]);
      return 'renamed';
    });
  },

  /**
   * On a successful transfer, bump the bot's daily match counter and stamp
   * last_selected_at.
   *
   * Georgia-day semantics with a 07:00 Tbilisi reset (schema comment): the
   * "roster day" is the Tbilisi calendar date AFTER shifting the clock back 7
   * hours, so a match at 06:59 Tbilisi still counts toward the previous day and
   * the counter rolls over at 07:00. Computed entirely in SQL to avoid any
   * JS/DB timezone drift; the counter resets lazily when the current roster day
   * differs from the stored matches_day (no 07:00 cron zeroing 1,000 rows).
   */
  async bumpMatchesTodayAndSelectedAt(botUserId: string): Promise<string | null> {
    const rows = await sql<{ matches_day: string | null }[]>`
      UPDATE synthetic_player_profiles
        SET
          matches_today = CASE
            WHEN matches_day IS DISTINCT FROM (
              (now() AT TIME ZONE 'Asia/Tbilisi' - interval '7 hours')::date
            ) THEN 1
            ELSE matches_today + 1
          END,
          matches_day = (now() AT TIME ZONE 'Asia/Tbilisi' - interval '7 hours')::date,
          last_selected_at = now(),
          updated_at = now()
      WHERE user_id = ${botUserId}
      RETURNING matches_day
    `;
    return rows[0]?.matches_day ?? null;
  },

  /**
   * Tx-aware variant of the daily bump — runs INSIDE the match-creation
   * transaction so the counter cannot drift from the reservation transfer (a
   * crash after commit no longer loses the count). Also stamps the last session
   * window timestamp into schedule.last_session_at (session tracking, §1.3) so
   * the session-preference eligibility rung has a signal to read. Idempotent per
   * match: the caller only invokes it when the transfer INSERT of match_id
   * actually happened in this same tx.
   */
  async bumpMatchesTodayAndSelectedAtTx(tx: TransactionSql, botUserId: string): Promise<void> {
    await tx.unsafe(
      `UPDATE synthetic_player_profiles
         SET
           matches_today = CASE
             WHEN matches_day IS DISTINCT FROM
               ((now() AT TIME ZONE 'Asia/Tbilisi' - interval '7 hours')::date)
             THEN 1 ELSE matches_today + 1 END,
           matches_day = (now() AT TIME ZONE 'Asia/Tbilisi' - interval '7 hours')::date,
           last_selected_at = now(),
           schedule = jsonb_set(
             COALESCE(schedule, '{}'::jsonb),
             '{last_session_at}',
             to_jsonb(now()),
             true
           ),
           updated_at = now()
       WHERE user_id = $1`,
      [botUserId],
    );
  },
};
