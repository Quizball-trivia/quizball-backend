export interface AuctionLeaderboardEntry {
  userId: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: unknown;
  auctionPoints: number;
  country: string | null;
  /** The player's RANKED tier (auction has no tiers of its own — the board
   *  borrows the ranked one; null until the player finishes placements). */
  tier: string | null;
}

export interface AuctionUserRankResult {
  auctionPoints: number;
  tier: string | null;
  rank: number;
  total: number;
}
