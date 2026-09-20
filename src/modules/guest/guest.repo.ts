import { sql } from '../../db/index.js';

export interface GuestSessionRow {
  id: string;
  token_hash: string;
  locale: string | null;
  linked_user_id: string | null;
  created_at: string;
  last_seen_at: string;
}

export const guestRepo = {
  async insert(data: { tokenHash: string; locale: string | null; ipHash: string | null; deviceHash: string | null }): Promise<GuestSessionRow> {
    const [row] = await sql<GuestSessionRow[]>`
      INSERT INTO guest_sessions (token_hash, locale, ip_hash, device_hash)
      VALUES (${data.tokenHash}, ${data.locale}, ${data.ipHash}, ${data.deviceHash})
      RETURNING id, token_hash, locale, linked_user_id, created_at, last_seen_at
    `;
    return row;
  },

  async findByTokenHash(tokenHash: string): Promise<GuestSessionRow | null> {
    const [row] = await sql<GuestSessionRow[]>`
      SELECT id, token_hash, locale, linked_user_id, created_at, last_seen_at
      FROM guest_sessions WHERE token_hash = ${tokenHash}
    `;
    return row ?? null;
  },

  /** Rate-limited to one write per minute per guest by the caller; keeps the table cheap. */
  async touch(id: string): Promise<void> {
    await sql`UPDATE guest_sessions SET last_seen_at = now() WHERE id = ${id} AND last_seen_at < now() - interval '1 minute'`;
  },

  async purgeIdle(days: number): Promise<number> {
    const rows = await sql`DELETE FROM guest_sessions WHERE last_seen_at < now() - make_interval(days => ${days}) RETURNING id`;
    return rows.length;
  },
  /** Idle sessions the sweeper must tombstone BEFORE deleting (the identity subject is only text). */
  async listIdleIds(days: number, limit = 500): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM guest_sessions WHERE last_seen_at < now() - make_interval(days => ${days}) ORDER BY last_seen_at ASC LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  },
  /**
   * Retires one idle session atomically: tombstone the users row (identifying
   * fields cleared, row kept for RESTRICT FKs), revoke the identity mapping,
   * delete the session. Any failure rolls the whole thing back so the next
   * sweep still finds the identity it needs. Returns the user id, if any.
   */
  async retireSession(sessionId: string, provider: string): Promise<{ userId: string | null }> {
    return sql.begin(async (tx) => {
      const [identity] = await tx.unsafe<{ user_id: string }[]>(
        'SELECT user_id FROM user_identities WHERE provider = $1 AND subject = $2 FOR UPDATE',
        [provider, sessionId],
      );
      if (identity) {
        await tx.unsafe(
          `UPDATE users
              SET nickname = NULL, email = NULL, phone_number = NULL, avatar_url = NULL, avatar_customization = NULL,
                  country = NULL, favorite_club = NULL, updated_at = now()
            WHERE id = $1 AND is_guest = true`,
          [identity.user_id],
        );
        await tx.unsafe('DELETE FROM user_identities WHERE provider = $1 AND subject = $2', [provider, sessionId]);
      }
      await tx.unsafe('DELETE FROM guest_sessions WHERE id = $1', [sessionId]);
      return { userId: identity?.user_id ?? null };
    });
  },
  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await sql`DELETE FROM guest_sessions WHERE id = ANY(${sql.array(ids)}::uuid[]) RETURNING id`;
    return rows.length;
  },

  async upsertDailyCompletion(data: { guestId: string; challengeType: string; challengeDay: string; score: number }): Promise<{ best_score: number; attempts: number }> {
    const [row] = await sql<Array<{ best_score: number; attempts: number }>>`
      INSERT INTO guest_daily_completions (guest_id, challenge_type, challenge_day, best_score)
      VALUES (${data.guestId}, ${data.challengeType}, ${data.challengeDay}::date, ${data.score})
      ON CONFLICT (guest_id, challenge_type, challenge_day) DO UPDATE
        SET best_score = GREATEST(guest_daily_completions.best_score, EXCLUDED.best_score),
            attempts = guest_daily_completions.attempts + 1,
            updated_at = now()
      RETURNING best_score, attempts
    `;
    return row;
  },
};
