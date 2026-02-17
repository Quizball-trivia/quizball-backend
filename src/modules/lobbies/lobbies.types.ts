export interface RankedLobbyContext {
  isPlacement?: boolean;
  placementGameNo?: number;
  aiAnchorRp?: number;
  aiCorrectness?: number;
  aiDelayProfile?: {
    minMs: number;
    maxMs: number;
  };
}

export interface LobbyRow {
  id: string;
  invite_code: string | null;
  mode: 'friendly' | 'ranked';
  game_mode: 'friendly' | 'ranked_sim';
  friendly_random: boolean;
  friendly_category_a_id: string | null;
  friendly_category_b_id: string | null;
  is_public: boolean;
  display_name: string;
  ranked_context: RankedLobbyContext | null;
  host_user_id: string;
  status: 'waiting' | 'active' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface LobbyWithJoinedAt extends LobbyRow {
  joined_at: string;
}

export interface LobbyMemberRow {
  lobby_id: string;
  user_id: string;
  is_ready: boolean;
  joined_at: string;
}

export interface LobbyCategoryRow {
  lobby_id: string;
  slot: number;
  category_id: string;
}

export interface LobbyCategoryBanRow {
  lobby_id: string;
  user_id: string;
  category_id: string;
  banned_at: string;
}

export interface LobbyMemberWithUser {
  lobby_id: string;
  user_id: string;
  is_ready: boolean;
  joined_at: string;
  nickname: string | null;
  avatar_url: string | null;
}

export interface LobbyCategoryWithDetails {
  category_id: string;
  slot: number;
  name: Record<string, string>;
  icon: string | null;
}
