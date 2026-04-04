export interface DayActivity {
  date: string;
  questions_created: number;
  categories_created: number;
  total: number;
  question_categories: DailyQuestionCategoryCount[];
  question_types: DailyQuestionTypeCount[];
}

export interface DailyQuestionCategoryCount {
  id: string | null;
  name: string;
  count: number;
}

export interface DailyQuestionTypeCount {
  type: string;
  count: number;
}

export interface ActionCounts {
  [action: string]: number;
}

export interface ActivitySummary {
  total_questions: number;
  total_categories: number;
  active_days: number;
  actions: ActionCounts;
}

export interface ActivityResponse {
  days: DayActivity[];
  summary: ActivitySummary;
}

export interface ActivityUser {
  id: string;
  email: string;
}

export interface CategoryBreakdownItem {
  id: string;
  name: string;
  question_count: number;
  is_active: boolean;
  last_question_created_at: string | null;
}

export interface RecentActivityItem {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface AuditLogInsert {
  userId: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}
