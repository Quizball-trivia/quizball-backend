export interface AuctionPipelineStageCount {
  stage: string;
  count: number;
}

export interface AuctionPipelineVariantCount {
  variant_key: string;
  count: number;
  published: number;
}

export interface AuctionPipelineAttemptErrorClass {
  error_class: string;
  count: number;
}

export interface AuctionPipelineFailureSample {
  id: string;
  task_id: string;
  task_stage: string;
  status: string;
  error_class: string | null;
  error_message: string | null;
  external_call: string | null;
  created_at: string;
}

export interface AuctionPipelineCardStatusCounts {
  published: number;
  needs_review: number;
  superseded: number;
  rejected: number;
  published_families: number;
}

export interface AuctionPipelineSnapshot {
  id: string;
  source: string;
  status: string;
  player_row_count: number;
  valuation_row_count: number;
  created_at: string;
  promoted_at: string | null;
}

export interface AuctionPipelinePoolCounts {
  eligible_players: number;
  players_with_published_card: number;
}

export interface AuctionPipelineTotals {
  total_tasks: number;
  terminal_families: number;
  published_families: number;
  rejected_families: number;
  failed_families: number;
  pass_rate: number | null;
  eligible_players: number;
  players_done: number;
  players_remaining: number;
  completion_rate: number | null;
}

export interface AuctionPipelineAttempts24h {
  total: number;
  success: number;
  rejected: number;
  failed: number;
  by_error_class: AuctionPipelineAttemptErrorClass[];
}

export interface AuctionPipelineStats {
  generated_at: string;
  totals: AuctionPipelineTotals;
  stages: AuctionPipelineStageCount[];
  variants: AuctionPipelineVariantCount[];
  cards: AuctionPipelineCardStatusCounts;
  attempts_24h: AuctionPipelineAttempts24h;
  recent_failures: AuctionPipelineFailureSample[];
  latest_snapshot: AuctionPipelineSnapshot | null;
}
