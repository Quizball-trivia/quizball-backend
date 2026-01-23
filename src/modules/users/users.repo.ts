import { sql } from '../../db/index.js';
import type { User } from '../../db/types.js';

export interface CreateUserData {
  email?: string | null;
  nickname?: string | null;
  country?: string | null;
  avatarUrl?: string | null;
}

export interface UpdateUserData {
  nickname?: string | null;
  country?: string | null;
  avatarUrl?: string | null;
  onboardingComplete?: boolean;
}

export const usersRepo = {
  async create(data: CreateUserData): Promise<User> {
    const [user] = await sql<User[]>`
      INSERT INTO users (email, nickname, country, avatar_url)
      VALUES (${data.email ?? null}, ${data.nickname ?? null}, ${data.country ?? null}, ${data.avatarUrl ?? null})
      RETURNING *
    `;
    return user;
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
