import { sql } from '../../db/index.js';
import type { UserIdentity, IdentityWithUser, User } from '../../db/types.js';

export type { IdentityWithUser };

export interface CreateIdentityData {
  userId: string;
  provider: string;
  subject: string;
  email?: string | null;
}

export const identitiesRepo = {
  async create(data: CreateIdentityData): Promise<UserIdentity> {
    const [identity] = await sql<UserIdentity[]>`
      INSERT INTO user_identities (id, user_id, provider, subject, email)
      VALUES (gen_random_uuid(), ${data.userId}, ${data.provider}, ${data.subject}, ${data.email ?? null})
      RETURNING *
    `;
    return identity;
  },

  async getByProviderSubject(
    provider: string,
    subject: string
  ): Promise<IdentityWithUser | null> {
    const [result] = await sql<(UserIdentity & { user_data: User })[]>`
      SELECT
        ui.*,
        row_to_json(u.*) as user_data
      FROM user_identities ui
      JOIN users u ON u.id = ui.user_id
      WHERE ui.provider = ${provider} AND ui.subject = ${subject}
    `;

    if (!result) return null;

    const { user_data, ...identity } = result;
    return { ...identity, user: user_data };
  },

  async getByUserId(userId: string): Promise<UserIdentity[]> {
    return sql<UserIdentity[]>`
      SELECT * FROM user_identities WHERE user_id = ${userId}
    `;
  },
};
