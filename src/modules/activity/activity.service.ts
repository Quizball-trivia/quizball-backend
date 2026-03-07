import { activityRepo } from './activity.repo.js';
import type {
  ActivityResponse,
  DayActivity,
  ActivityUser,
  CategoryBreakdownItem,
  RecentActivityItem,
} from './activity.types.js';

export const activityService = {
  async getActivity(userId: string, from: string, to: string): Promise<ActivityResponse> {
    const [dailyCounts, actionCounts] = await Promise.all([
      activityRepo.getDailyActivityCounts(userId, from, to),
      activityRepo.getActionCounts(userId, from, to),
    ]);

    // Merge into a single days array
    const dayMap = new Map<string, DayActivity>();

    for (const row of dailyCounts) {
      const existing = dayMap.get(row.date);
      if (existing) {
        if (row.action === 'create' && row.entity_type === 'question') {
          existing.questions_created += row.count;
        } else if (row.action === 'create' && row.entity_type === 'category') {
          existing.categories_created += row.count;
        }
        existing.total += row.count;
      } else {
        dayMap.set(row.date, {
          date: row.date,
          questions_created: row.action === 'create' && row.entity_type === 'question' ? row.count : 0,
          categories_created: row.action === 'create' && row.entity_type === 'category' ? row.count : 0,
          total: row.count,
        });
      }
    }

    const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    const totalQuestions = days.reduce((sum, d) => sum + d.questions_created, 0);
    const totalCategories = days.reduce((sum, d) => sum + d.categories_created, 0);

    return {
      days,
      summary: {
        total_questions: totalQuestions,
        total_categories: totalCategories,
        active_days: days.length,
        actions: actionCounts,
      },
    };
  },

  async getAdminUsers(): Promise<ActivityUser[]> {
    return activityRepo.getAdminUsers();
  },

  async getCategoryBreakdown(userId: string): Promise<CategoryBreakdownItem[]> {
    return activityRepo.getCategoryBreakdown(userId);
  },

  async getRecentActivity(userId: string, limit: number): Promise<RecentActivityItem[]> {
    return activityRepo.getRecentActivity(userId, limit);
  },
};
