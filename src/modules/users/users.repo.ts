import { sql } from '../../db/index.js';
import type { User } from '../../db/types.js';

export interface CreateUserData {
  email?: string | null;
  nickname?: string | null;
  country?: string | null;
  avatarUrl?: string | null;
}

export interface CreateIdentityData {
  provider: string;
  subject: string;
  email?: string | null;
}

export interface UpdateUserData {
  nickname?: string | null;
  country?: string | null;
  avatarUrl?: string | null;
  onboardingComplete?: boolean;
}

export const usersRepo = {
  async ensureFixedUser(data: {
    id: string;
    nickname: string;
    avatarUrl?: string | null;
  }): Promise<User> {
    const [user] = await sql<User[]>`
      INSERT INTO users (id, email, nickname, country, avatar_url, onboarding_complete)
      VALUES (${data.id}, null, ${data.nickname}, null, ${data.avatarUrl ?? null}, false)
      ON CONFLICT (id)
      DO UPDATE SET
        nickname = EXCLUDED.nickname,
        avatar_url = EXCLUDED.avatar_url,
        updated_at = NOW()
      RETURNING *
    `;
    return user;
  },

  async create(data: CreateUserData): Promise<User> {
    const [user] = await sql<User[]>`
      INSERT INTO users (id, email, nickname, country, avatar_url, onboarding_complete)
      VALUES (gen_random_uuid(), ${data.email ?? null}, ${data.nickname ?? null}, ${data.country ?? null}, ${data.avatarUrl ?? null}, false)
      RETURNING *
    `;
    return user;
  },

  /**
   * Create user with identity in a single transaction.
   * Prevents orphaned users if identity creation fails.
   */
  async createWithIdentity(
    userData: CreateUserData,
    identityData: CreateIdentityData
  ): Promise<User> {
    return sql.begin(async (tx) => {
      const result = await tx.unsafe<User[]>(
        `INSERT INTO users (id, email, nickname, country, avatar_url, onboarding_complete)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, false)
         RETURNING *`,
        [
          userData.email ?? null,
          userData.nickname ?? null,
          userData.country ?? null,
          userData.avatarUrl ?? null,
        ]
      );
      const user = result[0];

      await tx.unsafe(
        `INSERT INTO user_identities (id, user_id, provider, subject, email)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [user.id, identityData.provider, identityData.subject, identityData.email ?? null]
      );

      return user;
    });
  },

  async getById(id: string): Promise<User | null> {
    const [user] = await sql<User[]>`
      SELECT * FROM users WHERE id = ${id}
    `;
    return user ?? null;
  },

  async update(id: string, data: UpdateUserData): Promise<User | null> {
    // Use CASE to only update fields that are explicitly provided (not undefined)
    // undefined = keep existing, null = set to null, value = set to value
    const [user] = await sql<User[]>`
      UPDATE users
      SET
        nickname = CASE WHEN ${data.nickname !== undefined} THEN ${data.nickname ?? null} ELSE nickname END,
        country = CASE WHEN ${data.country !== undefined} THEN ${data.country ?? null} ELSE country END,
        avatar_url = CASE WHEN ${data.avatarUrl !== undefined} THEN ${data.avatarUrl ?? null} ELSE avatar_url END,
        onboarding_complete = CASE WHEN ${data.onboardingComplete !== undefined} THEN ${data.onboardingComplete ?? false} ELSE onboarding_complete END,
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return user ?? null;
  },
};
