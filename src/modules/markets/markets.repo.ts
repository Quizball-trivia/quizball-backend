import { sql } from '../../db/index.js';
import type { MarketDefinition } from './markets.logic.js';

export const marketsRepo = {
  async list(): Promise<MarketDefinition[]> {
    return sql<MarketDefinition[]>`
      SELECT code, name, countries FROM markets ORDER BY code
    `;
  },

  /** Profile countries of real players. Bots are left out: they are nobody's audience. */
  async listPlayerCountries(userIds: string[]): Promise<Array<{ id: string; country: string | null }>> {
    if (userIds.length === 0) return [];
    return sql<Array<{ id: string; country: string | null }>>`
      SELECT id, country
      FROM users
      WHERE id = ANY(${sql.array(userIds)}::uuid[])
        AND is_ai = false
    `;
  },
};
