export type DailyTrendPoint = {
  day: string; // YYYY-MM-DD (UTC)
  signups: number;
  dau: number;
  matches: number;
};

export type StatsOverview = {
  totalUsers: number;
  totalUsersExclPending: number;
  onboardedUsers: number;
  signupsToday: number;
  signupsYesterday: number;
  dauToday: number;
  dauYesterday: number;
  matchesToday: number;
  matchesYesterday: number;
  trend: DailyTrendPoint[];
};
