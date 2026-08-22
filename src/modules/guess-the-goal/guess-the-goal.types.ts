export interface I18nText {
  en: string;
  ka?: string | null;
}

export type ChoreographyStepKind = 'pass' | 'carry' | 'run' | 'shot';

export interface ChoreographyPlayer {
  id: string;
  team: 'attack' | 'defense' | 'keeper';
  at: [number, number];
}

export interface ChoreographyStep {
  kind: ChoreographyStepKind;
  player: string;
  to: [number, number];
  via?: [number, number];
  loft?: number;
  withPrev?: boolean;
  duration: number;
}

export interface ChoreographyOption {
  id: string;
  text: I18nText;
  is_correct: boolean;
}

export interface ChoreographyBonus {
  question: I18nText;
  options: ChoreographyOption[];
}

export interface GoalChoreographyRow {
  id: string;
  slug: string;
  status: 'draft' | 'published' | 'archived';
  difficulty: 'easy' | 'medium' | 'hard';
  title: I18nText;
  options: ChoreographyOption[];
  fun_fact: I18nText | null;
  bonus: ChoreographyBonus | null;
  players: ChoreographyPlayer[];
  steps: ChoreographyStep[];
  scorer: string;
  match_label: string;
  year: number;
  goal_ordinal: number;
  schema_version: number;
  video_url: string | null;
  /** Verified goal window in the source upload (embed plays exactly this). */
  clip_start_s: number | null;
  clip_end_s: number | null;
  source: 'seed' | 'agent' | 'editor';
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Immutable per-session snapshot of the served content. Player ids are
 * anonymized (p1..pN) so the diagram data can never leak the answer; options
 * keep is_correct here (the snapshot never leaves the backend un-stripped).
 */
export interface GoalSnapshot {
  difficulty: string;
  title: I18nText;
  fun_fact: I18nText | null;
  video_url: string | null;
  clip_start_s?: number | null;
  clip_end_s?: number | null;
  players: ChoreographyPlayer[];
  steps: ChoreographyStep[];
  options: ChoreographyOption[];
  bonus: ChoreographyBonus | null;
}

export type GgtSessionState = 'active' | 'guessed' | 'complete' | 'abandoned';

export interface GgtSessionRow {
  id: string;
  user_id: string;
  goal_id: string;
  goal_snapshot: GoalSnapshot;
  state: GgtSessionState;
  max_points: number;
  started_at: Date;
  guessed_at: Date | null;
  guess_option_id: string | null;
  guess_correct: boolean | null;
  revealed_moves: number | null;
  points: number;
  bonus_option_id: string | null;
  bonus_correct: boolean | null;
  bonus_points: number;
  first_solve: boolean;
  coins_awarded: number;
  xp_awarded: number;
  bonus_coins_awarded: number;
  bonus_xp_awarded: number;
  client_nonce: string | null;
  created_at: Date;
  updated_at: Date;
}
