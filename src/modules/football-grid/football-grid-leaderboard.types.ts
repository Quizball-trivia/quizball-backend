export interface FootballGridLeaderboardEntry {
  userId: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: unknown;
  ticTacToePoints: number;
  country: string | null;
  /** Tic Tac Toe has no tiers, so the shared leaderboard card displays the
   * player's Ranked tier after placement, matching the Auction leaderboard. */
  tier: string | null;
}

export interface FootballGridUserRankResult {
  ticTacToePoints: number;
  tier: string | null;
  rank: number;
  total: number;
}
