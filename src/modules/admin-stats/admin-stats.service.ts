import { adminStatsRepo } from './admin-stats.repo.js';
import type { StatsOverview } from './admin-stats.types.js';

export const adminStatsService = {
  async getOverview(): Promise<StatsOverview> {
    const [totals, trend] = await Promise.all([
      adminStatsRepo.getTotals(),
      adminStatsRepo.getDailyTrend(7),
    ]);
    return { ...totals, trend };
  },
};
