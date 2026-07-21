import { sql } from '../../db/index.js';

export interface EventAwardRow {
  id: string;
  event_slug: string;
  place: number;
  awarded_at: string;
  seen_at: string | null;
}

export const eventAwardsRepo = {
  async listForUser(userId: string): Promise<EventAwardRow[]> {
    return sql<EventAwardRow[]>`
      SELECT id, event_slug, place, awarded_at, seen_at
      FROM event_awards
      WHERE user_id = ${userId}
      ORDER BY awarded_at DESC, place ASC
    `;
  },

  async markSeen(userId: string, awardId: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
      UPDATE event_awards
      SET seen_at = NOW()
      WHERE id = ${awardId} AND user_id = ${userId} AND seen_at IS NULL
      RETURNING id
    `;
    return rows.length > 0;
  },
};
