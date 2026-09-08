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
