import type { RoomGameId } from '../room/room.types.js';
import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import {
  buildPossessionEligibilityHavingCounts,
  MATCHMAKING_CATEGORY_EXCLUSIONS,
  MCQ_HAS_IMAGE_CONDITIONS_NP_RAW,
  NORMALIZED_MCQ_PAYLOAD_LATERAL_RAW,
  RANKED_ELIGIBILITY_HAVING_COUNTS,
  VALID_PAYLOAD_CONDITIONS_NP_RAW,
} from '../../db/sql-fragments.js';
import type { DuelGameId } from '../duel/duel.types.js';
import { FRIENDLY_LOBBY_MAX_MEMBERS, lobbyCapacityByMode } from './lobby-modes.js';
import type {
  LobbyRow,
  LobbyWithJoinedAt,
  LobbyMemberRow,
  LobbyMemberWithUser,
  LobbyCategoryRow,
  LobbyCategoryWithDetails,
  LobbyCategoryBanRow,
  RankedLobbyContext,
} from './lobbies.types.js';

export interface CreateLobbyData {
  mode: 'friendly' | 'ranked';
  hostUserId: string;
  inviteCode: string | null;
  gameMode?: LobbyRow['game_mode'];
  /** Required with gameMode 'duel', null otherwise. */
  duelGame?: DuelGameId | null;
  /** Required with gameMode 'room_game', null otherwise. */
  roomGame?: RoomGameId | null;
  friendlyRandom?: boolean;
  friendlyCategoryAId?: string | null;
  friendlyCategoryBId?: string | null;
  isPublic?: boolean;
  displayName?: string;
  rankedContext?: RankedLobbyContext | null;
}

export interface CreateLobbyMemberData {
  userId: string;
  isReady: boolean;
}

export type FriendlyCategoryPool = 'mcq' | 'possession';

function friendlyCategoryCoverageSql(minQuestions: number, pool: FriendlyCategoryPool) {
  if (pool === 'possession') {
    return {
      questionTypeFilter: sql`AND q.type IN ('mcq_single', 'put_in_order', 'clue_chain')`,
      having: buildPossessionEligibilityHavingCounts(minQuestions),
    };
  }

  return {
    questionTypeFilter: sql`AND q.type = 'mcq_single'`,
    having: sql`HAVING COUNT(*) >= ${minQuestions}`,
  };
}

function deriveLobbyDefaults(data: CreateLobbyData) {
  return {
    gameMode: data.gameMode ?? (data.mode === 'ranked' ? 'ranked_sim' : 'friendly_possession'),
    friendlyRandom: data.friendlyRandom ?? true,
    isPublic: data.isPublic ?? false,
    displayName: data.displayName ?? '',
  };
}

export const lobbiesRepo = {
  async createLobby(data: CreateLobbyData): Promise<LobbyRow> {
    const { gameMode, friendlyRandom, isPublic, displayName } = deriveLobbyDefaults(data);
    const [row] = await sql<LobbyRow[]>`
      INSERT INTO lobbies (
        id,
        invite_code,
        mode,
        game_mode,
        duel_game,
        room_game,
        friendly_random,
        friendly_category_a_id,
        friendly_category_b_id,
        is_public,
        display_name,
        ranked_context,
        host_user_id,
        status
      )
      VALUES (
        gen_random_uuid(),
        ${data.inviteCode},
        ${data.mode},
        ${gameMode},
        ${data.duelGame ?? null},
        ${data.roomGame ?? null},
        ${friendlyRandom},
        ${data.friendlyCategoryAId ?? null},
        ${data.friendlyCategoryBId ?? null},
        ${isPublic},
        ${displayName},
        ${sql.json((data.rankedContext ?? null) as Json)},
        ${data.hostUserId},
        'waiting'
      )
      RETURNING *
    `;
    return row;
  },

  /**
   * Creates a lobby and its initial roster atomically in one database round
   * trip. Ranked matchmaking used to acquire the app DB bulkhead three times
   * per pair (lobby + two members), which becomes the dominant queue at a
   * streamer-scale join burst even though each Postgres statement is fast.
   */
  async createLobbyWithMembers(
    data: CreateLobbyData,
    members: [CreateLobbyMemberData, CreateLobbyMemberData],
  ): Promise<LobbyRow> {
    const { gameMode, friendlyRandom, isPublic, displayName } = deriveLobbyDefaults(data);
    const [row] = await sql<LobbyRow[]>`
      WITH created_lobby AS (
        INSERT INTO lobbies (
          id,
          invite_code,
          mode,
          game_mode,
          duel_game,
          room_game,
          friendly_random,
          friendly_category_a_id,
          friendly_category_b_id,
          is_public,
          display_name,
          ranked_context,
          host_user_id,
          status
        )
        VALUES (
          gen_random_uuid(),
          ${data.inviteCode},
          ${data.mode},
          ${gameMode},
          ${data.duelGame ?? null},
          ${data.roomGame ?? null},
          ${friendlyRandom},
          ${data.friendlyCategoryAId ?? null},
          ${data.friendlyCategoryBId ?? null},
          ${isPublic},
          ${displayName},
          ${sql.json((data.rankedContext ?? null) as Json)},
          ${data.hostUserId},
          'waiting'
        )
        RETURNING *
      ),
      created_members AS (
        INSERT INTO lobby_members (lobby_id, user_id, is_ready)
        SELECT created_lobby.id, member.user_id::uuid, member.is_ready::boolean
        FROM created_lobby
        CROSS JOIN (VALUES
          (${members[0].userId}, ${members[0].isReady}),
          (${members[1].userId}, ${members[1].isReady})
        ) AS member(user_id, is_ready)
        RETURNING lobby_id
      )
      SELECT created_lobby.*
      FROM created_lobby
      CROSS JOIN (SELECT COUNT(*) FROM created_members) AS inserted_members
    `;
    return row;
  },

  async getById(id: string): Promise<LobbyRow | null> {
    const [row] = await sql<LobbyRow[]>`
      SELECT * FROM lobbies WHERE id = ${id}
    `;
    return row ?? null;
  },

  /**
   * A friend room by invite code in any state (codes are unique over all rows): tells a refused join whether the room
   * ended, is mid-game or never existed, and whose room it was.
   */
  async findFriendlyRoomByInviteCode(
    inviteCode: string
  ): Promise<{ status: string; game_mode: string | null; duel_game: string | null; room_game: string | null; host_nickname: string | null } | null> {
    const [row] = await sql<{ status: string; game_mode: string | null; duel_game: string | null; room_game: string | null; host_nickname: string | null }[]>`
      SELECT l.status, l.game_mode, l.duel_game, l.room_game, u.nickname AS host_nickname
      FROM lobbies l
      LEFT JOIN users u ON u.id = l.host_user_id
      WHERE l.invite_code = ${inviteCode} AND l.mode = 'friendly'
    `;
    return row ?? null;
  },

  async getByInviteCode(inviteCode: string): Promise<LobbyRow | null> {
    const [row] = await sql<LobbyRow[]>`
      SELECT * FROM lobbies
      WHERE invite_code = ${inviteCode} AND status = 'waiting' AND mode = 'friendly'
    `;
    return row ?? null;
  },

  async findWaitingLobbyForUser(userId: string): Promise<LobbyRow | null> {
    const [row] = await sql<LobbyRow[]>`
      SELECT l.*
      FROM lobbies l
      JOIN lobby_members lm ON lm.lobby_id = l.id
      WHERE lm.user_id = ${userId}
        AND l.status = 'waiting'
      ORDER BY lm.joined_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async findOpenLobbyForUser(userId: string): Promise<LobbyRow | null> {
    const [row] = await sql<LobbyRow[]>`
      SELECT l.*
      FROM lobbies l
      JOIN lobby_members lm ON lm.lobby_id = l.id
      WHERE lm.user_id = ${userId}
        AND l.status IN ('waiting', 'active')
      ORDER BY lm.joined_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async listOpenLobbiesForUser(userId: string): Promise<LobbyWithJoinedAt[]> {
    return sql<LobbyWithJoinedAt[]>`
      SELECT l.*, lm.joined_at
      FROM lobbies l
      JOIN lobby_members lm ON lm.lobby_id = l.id
      WHERE lm.user_id = ${userId}
        AND l.status IN ('waiting', 'active')
      ORDER BY lm.joined_at DESC
    `;
  },

  async listOpenLobbiesForUsers(userIds: string[]): Promise<Map<string, LobbyWithJoinedAt[]>> {
    const uniqueUserIds = [...new Set(userIds)];
    const lobbiesByUserId = new Map(uniqueUserIds.map((userId) => [userId, [] as LobbyWithJoinedAt[]]));
    if (uniqueUserIds.length === 0) return lobbiesByUserId;

    const rows = await sql<Array<LobbyWithJoinedAt & { session_user_id: string }>>`
      SELECT lm.user_id AS session_user_id, l.*, lm.joined_at
      FROM lobby_members lm
      JOIN lobbies l ON l.id = lm.lobby_id
      WHERE lm.user_id = ANY(${sql.array(uniqueUserIds)}::uuid[])
        AND l.status IN ('waiting', 'active')
      ORDER BY lm.user_id, lm.joined_at DESC
    `;
    for (const { session_user_id: userId, ...lobby } of rows) {
      lobbiesByUserId.get(userId)?.push(lobby as LobbyWithJoinedAt);
    }
    return lobbiesByUserId;
  },

  async setLobbyStatus(lobbyId: string, status: LobbyRow['status']): Promise<void> {
    await sql`
      UPDATE lobbies
      SET status = ${status}, updated_at = NOW()
      WHERE id = ${lobbyId}
    `;
  },

  /**
   * Undo the updated_at stamp a heal-triggered host transfer leaves on a
   * lobby that is still waiting: the remaining members abandoned it just the
   * same, and their own heal keys off this idle time.
   */
  async restoreWaitingIdleSince(lobbyId: string, updatedAt: string): Promise<void> {
    await sql`
      UPDATE lobbies
      SET updated_at = ${updatedAt}
      WHERE id = ${lobbyId} AND status = 'waiting'
    `;
  },

  async setHostUser(lobbyId: string, userId: string): Promise<void> {
    await sql`
      UPDATE lobbies
      SET host_user_id = ${userId}, updated_at = NOW()
      WHERE id = ${lobbyId}
    `;
  },

  async deleteLobby(lobbyId: string): Promise<void> {
    await sql`
      DELETE FROM lobbies WHERE id = ${lobbyId}
    `;
  },

  async updateLobbySettings(
    lobbyId: string,
    settings: {
      gameMode: LobbyRow['game_mode'];
      /** Always written: switching away from a duel clears it (lobbies_duel_game_check). */
      duelGame: DuelGameId | null;
      /** Always written: switching away from a room game clears it (lobbies_room_game_check). */
      roomGame: RoomGameId | null;
      friendlyRandom: boolean;
      friendlyCategoryAId: string | null;
      friendlyCategoryBId: string | null;
    }
  ): Promise<LobbyRow | null> {
    const [row] = await sql<LobbyRow[]>`
      UPDATE lobbies
      SET
        game_mode = ${settings.gameMode},
        duel_game = ${settings.duelGame},
        -- A room's options belong to its game: another game (or mode) starts from that game's defaults.
        room_options = CASE WHEN room_game IS NOT DISTINCT FROM ${settings.roomGame} THEN room_options ELSE NULL END,
        room_game = ${settings.roomGame},
        friendly_random = ${settings.friendlyRandom},
        friendly_category_a_id = ${settings.friendlyCategoryAId},
        friendly_category_b_id = ${settings.friendlyCategoryBId},
        updated_at = NOW()
      WHERE id = ${lobbyId}
      RETURNING *
    `;
    return row ?? null;
  },

  async updateRankedContext(lobbyId: string, rankedContext: RankedLobbyContext | null): Promise<void> {
    await sql`
      UPDATE lobbies
      SET ranked_context = ${sql.json((rankedContext ?? null) as Json)}, updated_at = NOW()
      WHERE id = ${lobbyId}
    `;
  },

  async setVisibility(lobbyId: string, isPublic: boolean): Promise<void> {
    await sql`
      UPDATE lobbies
      SET is_public = ${isPublic}, updated_at = NOW()
      WHERE id = ${lobbyId}
    `;
  },

  async addMember(lobbyId: string, userId: string, isReady: boolean): Promise<LobbyMemberRow> {
    // `updated_at` is the idle signal the stranded-lobby heal relies on, so a
    // member joining is lobby activity too — folded into one statement.
    const [row] = await sql<LobbyMemberRow[]>`
      WITH member AS (
        INSERT INTO lobby_members (lobby_id, user_id, is_ready)
        VALUES (${lobbyId}, ${userId}, ${isReady})
        ON CONFLICT (lobby_id, user_id)
        DO UPDATE SET is_ready = ${isReady}
        RETURNING *
      ), touched AS (
        UPDATE lobbies SET updated_at = NOW() WHERE id = ${lobbyId}
      )
      SELECT * FROM member
    `;
    return row;
  },

  async removeMember(lobbyId: string, userId: string): Promise<void> {
    await sql`
      DELETE FROM lobby_members WHERE lobby_id = ${lobbyId} AND user_id = ${userId}
    `;
  },

  async removeMembers(lobbyId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await sql`
      DELETE FROM lobby_members
      WHERE lobby_id = ${lobbyId}
        AND user_id = ANY(${sql.array(userIds)}::uuid[])
    `;
  },

  async updateMemberReady(lobbyId: string, userId: string, isReady: boolean): Promise<boolean> {
    // A real readiness change in a waiting lobby is activity; replayed or
    // same-value ready events must not keep a stale lobby alive.
    const [row] = await sql<LobbyMemberRow[]>`
      WITH before AS (
        SELECT is_ready FROM lobby_members WHERE lobby_id = ${lobbyId} AND user_id = ${userId}
      ), member AS (
        UPDATE lobby_members
        SET is_ready = ${isReady}
        WHERE lobby_id = ${lobbyId} AND user_id = ${userId}
        RETURNING *
      ), touched AS (
        UPDATE lobbies SET updated_at = NOW()
        WHERE id = ${lobbyId}
          AND status = 'waiting'
          AND EXISTS (SELECT 1 FROM before WHERE before.is_ready IS DISTINCT FROM ${isReady})
      )
      SELECT * FROM member
    `;
    return row !== undefined;
  },

  /**
   * Readies a member only while the waiting room is still on the game they pressed Ready on. One transaction that
   * holds the room's row while it writes: a game change is two statements, the room and then everybody's readiness,
   * and the first of them either waits for this or is seen by it (a single statement would keep judging the room by
   * the snapshot it started with). Room before members, the order every transaction on the two tables uses. A room
   * that is not waiting is never locked: its match may be finishing under the same row.
   */
  async readyMemberOnGame(
    lobbyId: string,
    userId: string,
    seen: { gameMode: string; duelGame?: string | null; roomGame?: string | null },
  ): Promise<'ready' | 'game_changed' | 'not_waiting' | 'not_member'> {
    const seenDuel = seen.duelGame ?? null;
    const seenRoom = seen.roomGame ?? null;
    return sql.begin(async (transaction) => {
      const tx = transaction as unknown as typeof sql;
      const [room] = await tx<Array<{ id: string }>>`
        SELECT l.id FROM lobbies l
        WHERE l.id = ${lobbyId}
          AND l.status = 'waiting'
          AND l.game_mode = ${seen.gameMode}
          AND (${seen.gameMode} <> 'duel' OR l.duel_game IS NOT DISTINCT FROM ${seenDuel})
          -- A room game that names no game on either side (an older row, an older client) is not a mismatch.
          AND (${seen.gameMode} <> 'room_game' OR ${seenRoom}::text IS NULL OR l.room_game IS NULL OR l.room_game = ${seenRoom})
        FOR NO KEY UPDATE
      `;
      if (!room) {
        const [current] = await tx<Array<{ status: string }>>`SELECT status FROM lobbies WHERE id = ${lobbyId}`;
        return current && current.status === 'waiting' ? 'game_changed' : 'not_waiting';
      }
      const [member] = await tx<Array<{ was_ready: boolean }>>`
        WITH before AS (
          SELECT is_ready FROM lobby_members WHERE lobby_id = ${lobbyId} AND user_id = ${userId}
        )
        UPDATE lobby_members m SET is_ready = true
        FROM before
        WHERE m.lobby_id = ${lobbyId} AND m.user_id = ${userId}
        RETURNING before.is_ready AS was_ready
      `;
      if (!member) return 'not_member';
      // A real readiness change in a waiting lobby is activity (see updateMemberReady).
      if (!member.was_ready) await tx`UPDATE lobbies SET updated_at = NOW() WHERE id = ${lobbyId}`;
      return 'ready';
    }) as Promise<'ready' | 'game_changed' | 'not_waiting' | 'not_member'>;
  },

  async listMembersWithUser(lobbyId: string): Promise<LobbyMemberWithUser[]> {
    return sql<LobbyMemberWithUser[]>`
      SELECT lm.lobby_id, lm.user_id, lm.is_ready, lm.joined_at,
             COALESCE(pp.display_name, u.nickname) AS nickname,
             u.avatar_url, u.avatar_customization, u.favorite_club, u.is_ai, u.ai_kind, u.is_guest
      FROM lobby_members lm
      JOIN users u ON u.id = lm.user_id
      -- Partner players are shown under their partner name, never the internal handle in users.nickname.
      LEFT JOIN partner_players pp ON pp.user_id = u.id AND u.partner_slug IS NOT NULL
      WHERE lm.lobby_id = ${lobbyId}
      ORDER BY lm.joined_at ASC
    `;
  },

  async countMembers(lobbyId: string): Promise<number> {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM lobby_members WHERE lobby_id = ${lobbyId}
    `;
    return row?.count ?? 0;
  },

  async countReadyMembers(lobbyId: string): Promise<number> {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM lobby_members
      WHERE lobby_id = ${lobbyId} AND is_ready = true
    `;
    return row?.count ?? 0;
  },

  /** The host's choices for the room game; only a waiting room-game room of that game takes them. */
  /**
   * Stores a waiting room's game options and un-readies everyone, atomically: nobody stays ready for settings they did
   * not see. Members are locked first and the room second, the order a Ready (member, then the room's activity stamp)
   * and a start (members, then the room) take, so the three cannot deadlock. False when the room is no longer a waiting
   * room of that game.
   */
  async setRoomOptions(lobbyId: string, roomGame: RoomGameId, options: Record<string, unknown> | null): Promise<boolean> {
    return sql.begin(async (transaction) => {
      const tx = transaction as unknown as typeof sql;
      // Room before members, like a match finishing in this room and like readyMemberOnGame: one order, no deadlock.
      await tx`SELECT id FROM lobbies WHERE id = ${lobbyId} FOR NO KEY UPDATE`;
      await tx`SELECT user_id FROM lobby_members WHERE lobby_id = ${lobbyId} ORDER BY user_id FOR UPDATE`;
      const changed = await tx<Array<{ id: string }>>`
        UPDATE lobbies SET room_options = ${options === null ? null : tx.json(options as never)}, updated_at = NOW()
        WHERE id = ${lobbyId} AND status = 'waiting' AND game_mode = 'room_game' AND room_game = ${roomGame}
        RETURNING id
      `;
      if (changed.length !== 1) return false;
      await tx`UPDATE lobby_members SET is_ready = false WHERE lobby_id = ${lobbyId}`;
      return true;
    }) as Promise<boolean>;
  },

  async setAllReady(lobbyId: string, isReady: boolean): Promise<number> {
    const rows = await sql<{ updated: number }[]>`
      UPDATE lobby_members
      SET is_ready = ${isReady}
      WHERE lobby_id = ${lobbyId}
      RETURNING 1 as updated
    `;
    return rows.length;
  },

  /**
   * Live duels of the given rooms (a duel room is 'active' exactly while one of these exists).
   * Lives here, not in the duel module, because the session guard and connect hydration ask it
   * about lobbies.
   */
  async listLiveRoomsForLobbies(lobbyIds: string[]): Promise<Array<{ lobby_id: string; match_id: string; game: RoomGameId }>> {
    if (lobbyIds.length === 0) return [];
    return sql<Array<{ lobby_id: string; match_id: string; game: RoomGameId }>>`
      SELECT lobby_id, id AS match_id, game FROM room_matches
      WHERE lobby_id = ANY(${sql.array([...new Set(lobbyIds)])}::uuid[]) AND status IN ('ready', 'active')
    `;
  },

  async listLiveDuelsForLobbies(lobbyIds: string[]): Promise<Array<{ lobby_id: string; match_id: string; game: DuelGameId }>> {
    if (lobbyIds.length === 0) return [];
    return sql<Array<{ lobby_id: string; match_id: string; game: DuelGameId }>>`
      SELECT lobby_id, id AS match_id, game
      FROM duel_matches
      WHERE lobby_id = ANY(${sql.array([...new Set(lobbyIds)])}::uuid[])
        AND status IN ('ready', 'countdown', 'active', 'paused')
    `;
  },

  async listPublicLobbies(params: {
    limit: number;
    joinableOnly: boolean;
  }): Promise<Array<{
    lobby_id: string;
    invite_code: string;
    display_name: string;
    game_mode: LobbyRow['game_mode'];
    duel_game: LobbyRow['duel_game'];
    room_game: LobbyRow['room_game'];
    is_public: boolean;
    created_at: string;
    host_user_id: string;
    host_nickname: string | null;
    host_avatar_url: string | null;
    host_avatar_customization: unknown;
    member_count: number;
  }>> {
    return sql<Array<{
      lobby_id: string;
      invite_code: string;
      display_name: string;
      game_mode: LobbyRow['game_mode'];
      duel_game: LobbyRow['duel_game'];
      room_game: LobbyRow['room_game'];
      is_public: boolean;
      created_at: string;
      host_user_id: string;
      host_nickname: string | null;
      host_avatar_url: string | null;
      host_avatar_customization: unknown;
      member_count: number;
    }>>`
      SELECT
        l.id as lobby_id,
        l.invite_code,
        l.display_name,
        l.game_mode,
        l.duel_game,
        l.room_game,
        l.is_public,
        l.created_at,
        l.host_user_id,
        u.nickname as host_nickname,
        u.avatar_url as host_avatar_url,
        u.avatar_customization as host_avatar_customization,
        COUNT(lm.user_id)::int as member_count
      FROM lobbies l
      JOIN users u ON u.id = l.host_user_id
      LEFT JOIN lobby_members lm ON lm.lobby_id = l.id
      WHERE l.status = 'waiting'
        AND l.mode = 'friendly'
        AND l.is_public = true
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
      GROUP BY l.id, u.nickname, u.avatar_url, u.avatar_customization
      HAVING (
        ${params.joinableOnly}::boolean = false
        OR COUNT(lm.user_id) < COALESCE(
          (${sql.json(lobbyCapacityByMode())}::jsonb ->> l.game_mode)::int,
          ${FRIENDLY_LOBBY_MAX_MEMBERS}
        )
      )
      ORDER BY l.created_at DESC
      LIMIT ${params.limit}
    `;
  },

  async insertLobbyCategories(lobbyId: string, categories: Array<{ slot: number; categoryId: string }>): Promise<LobbyCategoryRow[]> {
    if (categories.length === 0) return [];

    const rows = categories.map((c) => [lobbyId, c.slot, c.categoryId]);

    const inserted = await sql<LobbyCategoryRow[]>`
      INSERT INTO lobby_categories (lobby_id, slot, category_id)
      VALUES ${sql(rows)}
      RETURNING *
    `;

    return inserted;
  },

  async listAllValidCategories(
    minQuestions: number,
    pool: FriendlyCategoryPool = 'mcq'
  ): Promise<Array<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }>> {
    // Friendly pools = NON-featured categories only. Party quiz needs MCQ
    // depth; possession additionally needs the two special slots in every
    // half. Counts-only (no payloads join / JSONB validation) — see
    // sql-fragments.ts for the rationale and staging identity verification.
    const coverage = friendlyCategoryCoverageSql(minQuestions, pool);
    return sql<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }[]>`
      SELECT c.id, c.name, c.icon, c.image_url
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      WHERE c.is_active = true
        ${MATCHMAKING_CATEGORY_EXCLUSIONS}
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        AND q.status = 'published'
        AND q.visibility = 'public'
        AND q.ranked_eligible = true
        ${coverage.questionTypeFilter}
      GROUP BY c.id, c.name, c.icon, c.image_url
      ${coverage.having}
    `;
  },

  async listAllRankedEligibleCategories(): Promise<Array<{
    id: string;
    name: Record<string, string>;
    icon: string | null;
    image_url: string | null;
  }>> {
    // Ranked draft pool = NON-featured categories. Featured held the World Cup
    // event content; with the event over, ranked draws from everything else
    // until the featured list is repurposed.
    return sql<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }[]>`
      SELECT c.id, c.name, c.icon, c.image_url
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      WHERE c.is_active = true
        ${MATCHMAKING_CATEGORY_EXCLUSIONS}
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        AND q.status = 'published'
        AND q.visibility = 'public'
        AND q.ranked_eligible = true
        AND q.type IN ('mcq_single', 'put_in_order', 'clue_chain')
      GROUP BY c.id, c.name, c.icon, c.image_url
      ${RANKED_ELIGIBILITY_HAVING_COUNTS}
    `;
  },

  async selectRandomActiveCategories(
    minQuestions: number,
    limit: number
  ): Promise<Array<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }>> {
    return sql<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }[]>`
      SELECT c.id, c.name, c.icon, c.image_url
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      WHERE c.is_active = true
        ${MATCHMAKING_CATEGORY_EXCLUSIONS}
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        AND q.status = 'published'
        AND q.visibility = 'public'
        AND q.ranked_eligible = true
        AND q.type = 'mcq_single'
      GROUP BY c.id, c.name, c.icon, c.image_url
      HAVING COUNT(*) >= ${minQuestions}
      ORDER BY RANDOM()
      LIMIT ${limit}
    `;
  },

  async selectRandomActiveCategoriesExcluding(
    minQuestions: number,
    limit: number,
    excludeCategoryIds: string[]
  ): Promise<Array<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }>> {
    const exclusionClause = excludeCategoryIds.length > 0
      ? sql`AND c.id <> ALL(${sql.array(excludeCategoryIds)}::uuid[])`
      : sql``;

    return sql<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }[]>`
      SELECT c.id, c.name, c.icon, c.image_url
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      WHERE c.is_active = true
        ${MATCHMAKING_CATEGORY_EXCLUSIONS}
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        ${exclusionClause}
        AND q.status = 'published'
        AND q.visibility = 'public'
        AND q.ranked_eligible = true
        AND q.type = 'mcq_single'
      GROUP BY c.id, c.name, c.icon, c.image_url
      HAVING COUNT(*) >= ${minQuestions}
      ORDER BY RANDOM()
      LIMIT ${limit}
    `;
  },

  async listValidCategoryIds(
    categoryIds: string[],
    minQuestions: number,
    pool: FriendlyCategoryPool = 'mcq'
  ): Promise<string[]> {
    if (categoryIds.length === 0) return [];

    const coverage = friendlyCategoryCoverageSql(minQuestions, pool);

    const rows = await sql<{ id: string }[]>`
      SELECT c.id
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      WHERE c.id = ANY(${sql.array(categoryIds)}::uuid[])
        AND c.is_active = true
        ${MATCHMAKING_CATEGORY_EXCLUSIONS}
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        AND q.status = 'published'
        AND q.visibility = 'public'
        AND q.ranked_eligible = true
        ${coverage.questionTypeFilter}
      GROUP BY c.id
      ${coverage.having}
    `;

    return rows.map((row) => row.id);
  },

  async listCategoryIdsWithMinPlainMcqCount(
    categoryIds: string[],
    minCount: number,
    matchId: string
  ): Promise<string[]> {
    if (categoryIds.length === 0) return [];

    // Mirrors the runtime plain-MCQ picker (match-questions.repo) exactly:
    // active category, valid payload, no image MCQs, and none already used by
    // this match — a looser count here would pass categories the picker can
    // still run dry on mid-shootout.
    const validPayload = VALID_PAYLOAD_CONDITIONS_NP_RAW.replace(/^\s*AND\s*/u, '');
    const imageMcq = MCQ_HAS_IMAGE_CONDITIONS_NP_RAW.replace(/^\s*AND\s*/u, '');
    const rows = await sql.unsafe<{ id: string }[]>(
      `
      SELECT q.category_id AS id
      FROM questions q
      JOIN categories c ON c.id = q.category_id
      JOIN question_payloads qp ON qp.question_id = q.id
      ${NORMALIZED_MCQ_PAYLOAD_LATERAL_RAW}
      WHERE q.category_id = ANY($1::uuid[])
        AND c.is_active = true
        AND q.status = 'published'
        AND q.visibility = 'public'
        AND q.ranked_eligible = true
        AND q.type = 'mcq_single'
        AND (${validPayload})
        AND NOT (${imageMcq})
        AND NOT EXISTS (
          SELECT 1
          FROM match_questions mq
          WHERE mq.match_id = $2
            AND mq.question_id = q.id
        )
      GROUP BY q.category_id
      HAVING COUNT(*) >= $3
      `,
      [categoryIds, matchId, minCount]
    );

    return rows.map((row) => row.id);
  },

  async listRankedEligibleCategoryIds(categoryIds: string[]): Promise<string[]> {
    if (categoryIds.length === 0) return [];

    const rows = await sql<{ id: string }[]>`
      SELECT c.id
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      WHERE c.id = ANY(${sql.array(categoryIds)}::uuid[])
        AND c.is_active = true
        ${MATCHMAKING_CATEGORY_EXCLUSIONS}
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        AND q.status = 'published'
        AND q.visibility = 'public'
        AND q.ranked_eligible = true
        AND q.type IN ('mcq_single', 'put_in_order', 'clue_chain')
      GROUP BY c.id
      ${RANKED_ELIGIBILITY_HAVING_COUNTS}
    `;

    return rows.map((row) => row.id);
  },

  async clearLobbyCategories(lobbyId: string): Promise<void> {
    await sql`
      DELETE FROM lobby_categories WHERE lobby_id = ${lobbyId}
    `;
  },

  async clearLobbyCategoryBans(lobbyId: string): Promise<void> {
    await sql`
      DELETE FROM lobby_category_bans WHERE lobby_id = ${lobbyId}
    `;
  },

  async listLobbyCategoriesWithDetails(lobbyId: string): Promise<LobbyCategoryWithDetails[]> {
    return sql<LobbyCategoryWithDetails[]>`
      SELECT lc.category_id, lc.slot, c.name, c.icon, c.image_url
      FROM lobby_categories lc
      JOIN categories c ON c.id = lc.category_id
      WHERE lc.lobby_id = ${lobbyId}
      ORDER BY lc.slot ASC
    `;
  },

  async listLobbyCategoryBans(lobbyId: string): Promise<LobbyCategoryBanRow[]> {
    return sql<LobbyCategoryBanRow[]>`
      SELECT * FROM lobby_category_bans WHERE lobby_id = ${lobbyId}
      ORDER BY banned_at ASC
    `;
  },

  // Idempotent against BOTH unique constraints on lobby_category_bans:
  //   - PK (lobby_id, user_id): the same user (re)bans → return their row.
  //   - UNIQUE (lobby_id, category_id): the category is already banned (by this
  //     user OR the opponent / a racing auto-ban) → return the existing row.
  // Either way the desired post-state — "this category is banned in this lobby"
  // — already holds, so we return the existing ban instead of throwing. The
  // returned row's `user_id` lets a caller that cares (the manual ban handler)
  // still detect a FOREIGN ban (user_id !== the actor) and prompt for another
  // pick. Throwing on the category collision used to dead-end the auto-ban /
  // AI-ban / recovery paths and wedge drafts on "preparing match"; making the
  // write idempotent removes that whole class of race.
  async insertLobbyCategoryBan(lobbyId: string, userId: string, categoryId: string): Promise<LobbyCategoryBanRow> {
    const [row] = await sql<LobbyCategoryBanRow[]>`
      INSERT INTO lobby_category_bans (lobby_id, user_id, category_id)
      VALUES (${lobbyId}, ${userId}, ${categoryId})
      ON CONFLICT (lobby_id, user_id) DO NOTHING
      RETURNING *
    `;
    if (row) return row;
    // PK conflict → this user already has a ban row; return it.
    const [existing] = await sql<LobbyCategoryBanRow[]>`
      SELECT * FROM lobby_category_bans
      WHERE lobby_id = ${lobbyId} AND user_id = ${userId}
      LIMIT 1
    `;
    if (existing) return existing;
    // No PK conflict and no row → the insert hit the (lobby_id, category_id)
    // UNIQUE constraint: a different user (or a racing auto-ban) already banned
    // this category. The category IS banned, which is the desired outcome —
    // return that existing ban rather than throwing and wedging the draft.
    const [foreign] = await sql<LobbyCategoryBanRow[]>`
      SELECT * FROM lobby_category_bans
      WHERE lobby_id = ${lobbyId} AND category_id = ${categoryId}
      LIMIT 1
    `;
    if (foreign) return foreign;
    // Neither lookup found a row — a transient state (e.g. the conflicting row
    // was deleted between INSERT and SELECT). Surface it so the caller's
    // recovery (auto-ban) can re-evaluate from a fresh read.
    throw new Error(`lobby_category_bans: failed to record ban for category ${categoryId} in lobby ${lobbyId}`);
  },
};
