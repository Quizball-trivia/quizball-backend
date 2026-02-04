import { statsRepo } from './stats.repo.js';

export interface HeadToHeadSummary {
  userAId: string;
  userBId: string;
  winsA: number;
  winsB: number;
  draws: number;
  total: number;
  lastPlayedAt: string | null;
}

export const statsService = {
  async getHeadToHead(userAId: string, userBId: string): Promise<HeadToHeadSummary> {
    const row = await statsRepo.getHeadToHead(userAId, userBId);
    return {
      userAId,
      userBId,
      winsA: row.wins_a,
      winsB: row.wins_b,
      draws: row.draws,
      total: row.total,
      lastPlayedAt: row.last_played_at,
    };
  },
};
