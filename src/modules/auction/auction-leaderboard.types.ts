export interface AuctionLeaderboardEntry {
  userId: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: unknown;
  auctionPoints: number;
  country: string | null;
}

export interface AuctionUserRankResult {
  auctionPoints: number;
  rank: number;
  total: number;
}
