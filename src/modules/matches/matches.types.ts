export interface MatchRow {
  id: string;
  lobby_id: string | null;
  mode: 'friendly' | 'ranked';
  status: 'active' | 'completed' | 'abandoned';
  category_a_id: string;
  category_b_id: string;
  current_q_index: number;
  total_questions: number;
  started_at: string;
  ended_at: string | null;
  winner_user_id: string | null;
}

export interface MatchPlayerRow {
  match_id: string;
  user_id: string;
  seat: number;
  total_points: number;
  correct_answers: number;
  avg_time_ms: number | null;
}

export interface MatchQuestionRow {
  match_id: string;
  q_index: number;
  question_id: string;
  category_id: string;
  correct_index: number;
  shown_at: string | null;
  deadline_at: string | null;
}

export interface MatchAnswerRow {
  match_id: string;
  q_index: number;
  user_id: string;
  selected_index: number | null;
  is_correct: boolean;
  time_ms: number;
  points_earned: number;
  answered_at: string;
}

export interface MatchQuestionWithPayload {
  id: string;
  prompt: Record<string, string>;
  difficulty: string;
  category_id: string;
  payload: unknown;
}

export interface MatchQuestionWithCategory {
  question_id: string;
  q_index: number;
  category_id: string;
  correct_index: number;
  prompt: Record<string, string>;
  difficulty: string;
  payload: unknown;
  category_name: Record<string, string>;
  category_icon: string | null;
}

export interface MatchQuestionTimingRow {
  shown_at: string | null;
  deadline_at: string | null;
}
