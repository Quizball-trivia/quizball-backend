import postgres from 'postgres';

/**
 * Database-side truth for the lobby-lifecycle harness. The socket traces say
 * what players SAW; these queries say what the server LEFT BEHIND. The
 * stranded-lobby leak (Aug-2026) was invisible to every socket-level check
 * and obvious here: a membership row for a player with no socket.
 */
export interface OpenLobbyRow {
  lobbyId: string;
  mode: string;
  gameMode: string;
  status: string;
  hostUserId: string | null;
  memberCount: number;
  harnessMemberCount: number;
  hostIsMember: boolean;
  hasActiveMatch: boolean;
  idleSec: number;
}

export interface LobbyInvariantReport {
  checkedAt: string;
  /** waiting lobby still holding harness members although every socket is gone */
  orphanWaitingLobbies: OpenLobbyRow[];
  /** active lobby (draft/auction) with no live match row behind it */
  staleActiveLobbies: OpenLobbyRow[];
  /** active lobby whose match is still running — the match sweeper's job, informational */
  inFlightMatchLobbies: OpenLobbyRow[];
  /** open lobby whose host is not a member */
  hostlessLobbies: OpenLobbyRow[];
  /** open lobby with no members at all (never closed) */
  emptyOpenLobbies: OpenLobbyRow[];
  /** active matches of harness users idle longer than the sweeper should allow */
  hungMatches: Array<{ matchId: string; mode: string; idleSec: number; players: number }>;
  /** membership rows left in CLOSED lobbies (harmless to queue joins, still debris) */
  danglingClosedMemberRows: number;
  /** harness users currently holding an active match row */
  usersInActiveMatches: number;
  violations: string[];
}

const PROD_PROJECT = 'lfbwhxvwubzeqkztghok';

function assertNonProdDatabase(databaseUrl: string): void {
  if (databaseUrl.includes(PROD_PROJECT)) {
    throw new Error('PROD GUARD: lobby-lifecycle harness refuses to touch production.');
  }
  const local = /@(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(databaseUrl);
  const staging = databaseUrl.includes('nsdfiprfmhdqhbfxfwpv');
  if (!local && !staging) {
    throw new Error('PROD GUARD: lobby-lifecycle harness only accepts a localhost or staging database.');
  }
}

/**
 * Put every harness identity back to a clean slate so the run measures only
 * what THIS run leaks. Mirrors the party fleet's reset; scoped to the given
 * users, never a global sweep.
 */
export async function resetLobbyFixtures(
  databaseUrl: string,
  userIds: string[],
): Promise<{ abandonedMatches: number; closedLobbies: number; removedMemberRows: number }> {
  assertNonProdDatabase(databaseUrl);
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return { abandonedMatches: 0, closedLobbies: 0, removedMemberRows: 0 };
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 5 });
  try {
    return await sql.begin(async (tx) => {
      const abandoned = await tx<{ id: string }[]>`
        UPDATE matches AS m
        SET status = 'abandoned', ended_at = NOW()
        WHERE m.status = 'active'
          AND EXISTS (
            SELECT 1 FROM match_players mp
            WHERE mp.match_id = m.id AND mp.user_id IN ${tx(ids)}
          )
        RETURNING m.id
      `;
      const closed = await tx<{ id: string }[]>`
        UPDATE lobbies AS l
        SET status = 'closed', updated_at = NOW()
        WHERE l.status IN ('waiting', 'active')
          AND EXISTS (
            SELECT 1 FROM lobby_members lm
            WHERE lm.lobby_id = l.id AND lm.user_id IN ${tx(ids)}
          )
        RETURNING l.id
      `;
      const removed = await tx<{ lobby_id: string }[]>`
        DELETE FROM lobby_members
        WHERE user_id IN ${tx(ids)}
        RETURNING lobby_id
      `;
      // A crash between member removal and lobby close leaves a memberless
      // open lobby behind (seen after SIGKILL runs); it is invisible to the
      // session guard but would fail the next run's audit as prior debris.
      await tx`
        UPDATE lobbies
        SET status = 'closed', updated_at = NOW()
        WHERE status IN ('waiting', 'active')
          AND host_user_id IN ${tx(ids)}
          AND NOT EXISTS (SELECT 1 FROM lobby_members m WHERE m.lobby_id = lobbies.id)
      `;
      return {
        abandonedMatches: abandoned.length,
        closedLobbies: closed.length,
        removedMemberRows: removed.length,
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Must run AFTER every harness socket is disconnected and the server's
 * waiting-lobby disconnect grace (15s) has elapsed — at that point any open
 * lobby still holding a harness member is a leak, not a race.
 */
export async function checkLobbyInvariants(
  databaseUrl: string,
  userIds: string[],
  options: { staleActiveIdleSec?: number; hungMatchIdleSec?: number } = {},
): Promise<LobbyInvariantReport> {
  assertNonProdDatabase(databaseUrl);
  const ids = [...new Set(userIds)];
  // A draft or auction legitimately runs as an active lobby with no matches
  // row; only prolonged silence makes it stale (the server's own heal uses
  // 30 min, the harness wants to know sooner).
  const staleActiveIdleSec = options.staleActiveIdleSec ?? 180;
  // The stale-match sweeper fires at 15 min; anything older is hung for real.
  const hungMatchIdleSec = options.hungMatchIdleSec ?? 16 * 60;
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 5 });
  try {
    const rows = await sql<Array<{
      lobby_id: string;
      mode: string;
      game_mode: string;
      status: string;
      host_user_id: string | null;
      member_count: number;
      harness_member_count: number;
      host_is_member: boolean;
      has_active_match: boolean;
      idle_sec: number;
    }>>`
      SELECT
        l.id AS lobby_id,
        l.mode,
        l.game_mode,
        l.status,
        l.host_user_id,
        (SELECT count(*)::int FROM lobby_members m WHERE m.lobby_id = l.id) AS member_count,
        (SELECT count(*)::int FROM lobby_members m
           WHERE m.lobby_id = l.id AND m.user_id IN ${sql(ids)}) AS harness_member_count,
        EXISTS (SELECT 1 FROM lobby_members m WHERE m.lobby_id = l.id AND m.user_id = l.host_user_id) AS host_is_member,
        EXISTS (SELECT 1 FROM matches x WHERE x.lobby_id = l.id AND x.status = 'active') AS has_active_match,
        EXTRACT(EPOCH FROM (NOW() - l.updated_at))::int AS idle_sec
      FROM lobbies l
      WHERE l.status IN ('waiting', 'active')
        AND (
          l.host_user_id IN ${sql(ids)}
          OR EXISTS (
            SELECT 1 FROM lobby_members m
            WHERE m.lobby_id = l.id AND m.user_id IN ${sql(ids)}
          )
        )
      ORDER BY l.updated_at
    `;
    const [dangling] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM lobby_members m
      JOIN lobbies l ON l.id = m.lobby_id
      WHERE m.user_id IN ${sql(ids)}
        AND l.status = 'closed'
    `;
    const [inMatches] = await sql<{ n: number }[]>`
      SELECT count(DISTINCT mp.user_id)::int AS n
      FROM match_players mp
      JOIN matches x ON x.id = mp.match_id
      WHERE x.status = 'active' AND mp.user_id IN ${sql(ids)}
    `;
    const hung = await sql<Array<{ match_id: string; mode: string; idle_sec: number; players: number }>>`
      SELECT x.id AS match_id, x.mode,
             EXTRACT(EPOCH FROM (NOW() - COALESCE(x.updated_at, x.started_at)))::int AS idle_sec,
             (SELECT count(*)::int FROM match_players p WHERE p.match_id = x.id) AS players
      FROM matches x
      WHERE x.status = 'active'
        AND COALESCE(x.updated_at, x.started_at) < NOW() - make_interval(secs => ${hungMatchIdleSec})
        AND EXISTS (SELECT 1 FROM match_players mp WHERE mp.match_id = x.id AND mp.user_id IN ${sql(ids)})
    `;

    const open: OpenLobbyRow[] = rows.map((row) => ({
      lobbyId: row.lobby_id,
      mode: row.mode,
      gameMode: row.game_mode,
      status: row.status,
      hostUserId: row.host_user_id,
      memberCount: row.member_count,
      harnessMemberCount: row.harness_member_count,
      hostIsMember: row.host_is_member,
      hasActiveMatch: row.has_active_match,
      idleSec: row.idle_sec,
    }));

    const orphanWaitingLobbies = open.filter((l) => l.status === 'waiting' && l.harnessMemberCount > 0);
    const staleActiveLobbies = open.filter((l) =>
      l.status === 'active' && !l.hasActiveMatch && l.idleSec >= staleActiveIdleSec);
    const inFlightMatchLobbies = open.filter((l) => l.status === 'active' && l.hasActiveMatch);
    const hostlessLobbies = open.filter((l) => l.memberCount > 0 && !l.hostIsMember);
    // A lobby row with zero members is closed-in-all-but-name; the sessions
    // guard never sees it (listOpenLobbiesForUser joins through members).
    const emptyOpenLobbies = open.filter((l) => l.memberCount === 0);

    const violations: string[] = [];
    if (orphanWaitingLobbies.length > 0) {
      violations.push(`${orphanWaitingLobbies.length} waiting lobbies still hold harness members with no socket`);
    }
    if (staleActiveLobbies.length > 0) {
      violations.push(`${staleActiveLobbies.length} active lobbies have no live match behind them`);
    }
    if (hostlessLobbies.length > 0) {
      violations.push(`${hostlessLobbies.length} open lobbies whose host is not a member`);
    }
    if (emptyOpenLobbies.length > 0) {
      violations.push(`${emptyOpenLobbies.length} open lobbies with zero members (never closed)`);
    }
    const hungMatches = hung.map((row) => ({ matchId: row.match_id, mode: row.mode, idleSec: row.idle_sec, players: row.players }));
    if (hungMatches.length > 0) {
      violations.push(`${hungMatches.length} active matches idle longer than ${hungMatchIdleSec}s (sweeper never resolved them)`);
    }
    return {
      checkedAt: new Date().toISOString(),
      orphanWaitingLobbies,
      staleActiveLobbies,
      inFlightMatchLobbies,
      hostlessLobbies,
      emptyOpenLobbies,
      hungMatches,
      danglingClosedMemberRows: dangling?.n ?? 0,
      usersInActiveMatches: inMatches?.n ?? 0,
      violations,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Backdate one harness lobby so it looks idle for `minutes` (heal-threshold testing). */
export async function ageLobby(databaseUrl: string, lobbyId: string, minutes: number): Promise<void> {
  assertNonProdDatabase(databaseUrl);
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 5 });
  try {
    await sql`
      UPDATE lobbies
      SET updated_at = NOW() - make_interval(mins => ${minutes}),
          created_at = LEAST(created_at, NOW() - make_interval(mins => ${minutes}))
      WHERE id = ${lobbyId} AND status IN ('waiting', 'active')
    `;
    await sql`
      UPDATE lobby_members
      SET joined_at = NOW() - make_interval(mins => ${minutes})
      WHERE lobby_id = ${lobbyId}
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
