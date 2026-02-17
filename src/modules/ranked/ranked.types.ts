export type RankedTier =
  | 'Academy'
  | 'Youth Prospect'
  | 'Reserve'
  | 'Bench'
  | 'Rotation'
  | 'Starting11'
  | 'Key Player'
  | 'Captain'
  | 'World-Class'
  | 'Legend'
  | 'GOAT';

export type PlacementStatus = 'unplaced' | 'in_progress' | 'placed';

export interface RankedProfileRow {
  user_id: string;
  rp: number;
  tier: RankedTier;
  placement_status: PlacementStatus;
  placement_required: number;
  placement_played: number;
  placement_wins: number;
  placement_seed_rp: number | null;
  placement_perf_sum: number;
  placement_points_for_sum: number;
  placement_points_against_sum: number;
  current_win_streak: number;
  last_ranked_match_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RankedRpChangeRow {
  id: string;
  match_id: string;
  user_id: string;
  opponent_user_id: string | null;
  opponent_is_ai: boolean;
  old_rp: number;
  delta_rp: number;
  new_rp: number;
  result: 'win' | 'loss';
  is_placement: boolean;
  placement_game_no: number | null;
  placement_anchor_rp: number | null;
  placement_perf_score: number | null;
  calculation_method: 'placement_seed' | 'ranked_formula';
  created_at: string;
}

export interface RankedPlacementAiContext {
  isPlacement: true;
  placementGameNo: number;
  aiAnchorRp: number;
  aiCorrectness: number;
  aiDelayProfile: {
    minMs: number;
    maxMs: number;
  };
}

export interface RankedUserOutcome {
  userId: string;
  oldRp: number;
  newRp: number;
  deltaRp: number;
  oldTier: RankedTier;
  newTier: RankedTier;
  placementStatus: PlacementStatus;
  placementPlayed: number;
  placementRequired: number;
  isPlacement: boolean;
}

export interface RankedMatchOutcome {
  isPlacement: boolean;
  byUserId: Record<string, RankedUserOutcome>;
}

export interface RankedLeaderboardEntry {
  userId: string;
  username: string;
  avatarUrl: string | null;
  rp: number;
  tier: RankedTier;
}

