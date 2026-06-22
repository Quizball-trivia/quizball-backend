export type ClueCardDifficulty = 'easy' | 'medium' | 'hard';
export type ClueCardStatus = 'draft' | 'needs_review' | 'approved' | 'published' | 'rejected';
export type ClueCardSource = 'generated' | 'manual' | 'cms' | 'imported';
export type ClueCardLocale = 'en' | 'ka';
export type MatchStatus = 'matched' | 'ambiguous' | 'unmatched';
export type MatchConfidence = 'high' | 'medium' | 'low';
export type MatchMethod = 'exact' | 'normalized' | 'alias';

export interface ParsedClueRow {
  rowIndex: number;
  sourcePlayerNumber: number | null;
  answerName: string;
  difficulty: ClueCardDifficulty;
  difficultySource: 'row' | 'default' | 'ai';
  clue1: string;
  clue2: string;
  clue3: string;
  warnings: string[];
  validationErrors: string[];
  factRiskFlags: string[];
  originalText: string;
}

export interface FootballPlayerCandidate {
  footballPlayerId: string;
  transfermarktId: number | null;
  name: string;
  currentClub: string | null;
  nationality: string | null;
  positionGroup: string | null;
  imageUrl: string | null;
  currentValueEur: number | null;
  normalizedName: string;
}

export interface PreviewRow extends ParsedClueRow {
  matchStatus: MatchStatus;
  matchedPlayer: FootballPlayerCandidate | null;
  candidates: FootballPlayerCandidate[];
  matchMethod: MatchMethod | null;
  matchConfidence: MatchConfidence | null;
  /** This resolved player already appears earlier in the same upload. */
  duplicateInBatch: boolean;
  /** This player already has a card for this locale in the database. */
  alreadyHasCard: boolean;
}

export interface PreviewResult {
  rowsParsed: number;
  matchedCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
  duplicateCount: number;
  warningCount: number;
  rows: PreviewRow[];
}

export interface CommitRow {
  rowIndex: number;
  answerName: string;
  difficulty: ClueCardDifficulty | null;
  clue1: string;
  clue2: string;
  clue3: string;
  footballPlayerId: string;
  originalText: string;
  sourcePlayerNumber: number | null;
  manualMapping: boolean;
  matchMethod: string | null;
  matchConfidence: MatchConfidence | null;
  factRiskFlags: string[];
}

export interface CommitResultRow {
  rowIndex: number;
  status: 'inserted' | 'updated' | 'skipped_existing' | 'failed';
  clueCardId: string | null;
  error: string | null;
}

export interface CommitResult {
  total: number;
  inserted: number;
  updated: number;
  skippedExisting: number;
  failed: number;
  rows: CommitResultRow[];
}

export interface PlayerClueCardRow {
  id: string;
  football_player_id: string;
  transfermarkt_id: number | null;
  locale: string;
  clue_1: string;
  clue_2: string;
  clue_3: string;
  difficulty: string;
  status: string;
  source: string;
  generation_provider: string | null;
  generation_model: string | null;
  prompt_version: string;
  evidence: Record<string, unknown>;
  source_payload: Record<string, unknown>;
  review_notes: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlayerClueCardDetail extends PlayerClueCardRow {
  playerName: string;
  playerImageUrl: string | null;
  playerPositionGroup: string | null;
  playerNationality: string | null;
  playerCurrentClub: string | null;
}
