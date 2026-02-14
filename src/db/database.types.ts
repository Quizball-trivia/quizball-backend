export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      categories: {
        Row: {
          created_at: string
          description: Json | null
          icon: string | null
          id: string
          image_url: string | null
          is_active: boolean
          name: Json
          parent_id: string | null
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: Json | null
          icon?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          name: Json
          parent_id?: string | null
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: Json | null
          icon?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          name?: Json
          parent_id?: string | null
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      featured_categories: {
        Row: {
          category_id: string
          created_at: string
          id: string
          sort_order: number
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          sort_order?: number
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "featured_categories_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: true
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      lobbies: {
        Row: {
          created_at: string
          display_name: string
          friendly_category_a_id: string | null
          friendly_category_b_id: string | null
          friendly_random: boolean
          game_mode: string
          host_user_id: string
          id: string
          invite_code: string | null
          is_public: boolean
          mode: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string
          friendly_category_a_id?: string | null
          friendly_category_b_id?: string | null
          friendly_random?: boolean
          game_mode?: string
          host_user_id: string
          id?: string
          invite_code?: string | null
          is_public?: boolean
          mode: string
          status: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          friendly_category_a_id?: string | null
          friendly_category_b_id?: string | null
          friendly_random?: boolean
          game_mode?: string
          host_user_id?: string
          id?: string
          invite_code?: string | null
          is_public?: boolean
          mode?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lobbies_friendly_category_a_id_fkey"
            columns: ["friendly_category_a_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lobbies_friendly_category_b_id_fkey"
            columns: ["friendly_category_b_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lobbies_host_user_id_fkey"
            columns: ["host_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      lobby_categories: {
        Row: {
          category_id: string
          lobby_id: string
          slot: number
        }
        Insert: {
          category_id: string
          lobby_id: string
          slot: number
        }
        Update: {
          category_id?: string
          lobby_id?: string
          slot?: number
        }
        Relationships: [
          {
            foreignKeyName: "lobby_categories_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lobby_categories_lobby_id_fkey"
            columns: ["lobby_id"]
            isOneToOne: false
            referencedRelation: "lobbies"
            referencedColumns: ["id"]
          },
        ]
      }
      lobby_category_bans: {
        Row: {
          banned_at: string
          category_id: string
          lobby_id: string
          user_id: string
        }
        Insert: {
          banned_at?: string
          category_id: string
          lobby_id: string
          user_id: string
        }
        Update: {
          banned_at?: string
          category_id?: string
          lobby_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lobby_category_bans_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lobby_category_bans_lobby_id_fkey"
            columns: ["lobby_id"]
            isOneToOne: false
            referencedRelation: "lobbies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lobby_category_bans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      lobby_members: {
        Row: {
          is_ready: boolean
          joined_at: string
          lobby_id: string
          user_id: string
        }
        Insert: {
          is_ready?: boolean
          joined_at?: string
          lobby_id: string
          user_id: string
        }
        Update: {
          is_ready?: boolean
          joined_at?: string
          lobby_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lobby_members_lobby_id_fkey"
            columns: ["lobby_id"]
            isOneToOne: false
            referencedRelation: "lobbies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lobby_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      match_answers: {
        Row: {
          answered_at: string
          is_correct: boolean
          match_id: string
          phase_kind: string
          phase_round: number | null
          points_earned: number
          q_index: number
          selected_index: number | null
          shooter_seat: number | null
          time_ms: number
          user_id: string
        }
        Insert: {
          answered_at?: string
          is_correct: boolean
          match_id: string
          phase_kind?: string
          phase_round?: number | null
          points_earned: number
          q_index: number
          selected_index?: number | null
          shooter_seat?: number | null
          time_ms: number
          user_id: string
        }
        Update: {
          answered_at?: string
          is_correct?: boolean
          match_id?: string
          phase_kind?: string
          phase_round?: number | null
          points_earned?: number
          q_index?: number
          selected_index?: number | null
          shooter_seat?: number | null
          time_ms?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_answers_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_answers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      match_players: {
        Row: {
          avg_time_ms: number | null
          correct_answers: number
          goals: number
          match_id: string
          penalty_goals: number
          seat: number
          total_points: number
          user_id: string
        }
        Insert: {
          avg_time_ms?: number | null
          correct_answers?: number
          goals?: number
          match_id: string
          penalty_goals?: number
          seat: number
          total_points?: number
          user_id: string
        }
        Update: {
          avg_time_ms?: number | null
          correct_answers?: number
          goals?: number
          match_id?: string
          penalty_goals?: number
          seat?: number
          total_points?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_players_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_players_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      match_questions: {
        Row: {
          attacker_seat: number | null
          category_id: string
          correct_index: number
          deadline_at: string | null
          match_id: string
          phase_kind: string
          phase_round: number | null
          q_index: number
          question_id: string
          shooter_seat: number | null
          shown_at: string | null
        }
        Insert: {
          attacker_seat?: number | null
          category_id: string
          correct_index: number
          deadline_at?: string | null
          match_id: string
          phase_kind?: string
          phase_round?: number | null
          q_index: number
          question_id: string
          shooter_seat?: number | null
          shown_at?: string | null
        }
        Update: {
          attacker_seat?: number | null
          category_id?: string
          correct_index?: number
          deadline_at?: string | null
          match_id?: string
          phase_kind?: string
          phase_round?: number | null
          q_index?: number
          question_id?: string
          shooter_seat?: number | null
          shown_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "match_questions_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_questions_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_questions_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      matches: {
        Row: {
          category_a_id: string
          category_b_id: string
          current_q_index: number
          ended_at: string | null
          id: string
          lobby_id: string | null
          mode: string
          started_at: string
          state_payload: Json | null
          status: string
          total_questions: number
          updated_at: string
          winner_user_id: string | null
        }
        Insert: {
          category_a_id: string
          category_b_id: string
          current_q_index?: number
          ended_at?: string | null
          id?: string
          lobby_id?: string | null
          mode: string
          started_at?: string
          state_payload?: Json | null
          status: string
          total_questions?: number
          updated_at?: string
          winner_user_id?: string | null
        }
        Update: {
          category_a_id?: string
          category_b_id?: string
          current_q_index?: number
          ended_at?: string | null
          id?: string
          lobby_id?: string | null
          mode?: string
          started_at?: string
          state_payload?: Json | null
          status?: string
          total_questions?: number
          updated_at?: string
          winner_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matches_category_a_id_fkey"
            columns: ["category_a_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_category_b_id_fkey"
            columns: ["category_b_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_lobby_id_fkey"
            columns: ["lobby_id"]
            isOneToOne: false
            referencedRelation: "lobbies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_winner_user_id_fkey"
            columns: ["winner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      question_payloads: {
        Row: {
          created_at: string
          id: string
          payload: Json
          question_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          payload: Json
          question_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          payload?: Json
          question_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "question_payloads_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: true
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      questions: {
        Row: {
          category_id: string
          created_at: string
          difficulty: string
          explanation: Json | null
          id: string
          prompt: Json
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          category_id: string
          created_at?: string
          difficulty: string
          explanation?: Json | null
          id?: string
          prompt: Json
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          category_id?: string
          created_at?: string
          difficulty?: string
          explanation?: Json | null
          id?: string
          prompt?: Json
          status?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "questions_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      user_identities: {
        Row: {
          created_at: string
          email: string | null
          id: string
          provider: string
          subject: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          provider: string
          subject: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          provider?: string
          subject?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_identities_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_mode_match_stats: {
        Row: {
          draws: number
          games_played: number
          last_match_at: string | null
          losses: number
          mode: string
          updated_at: string
          user_id: string
          wins: number
        }
        Insert: {
          draws?: number
          games_played?: number
          last_match_at?: string | null
          losses?: number
          mode: string
          updated_at?: string
          user_id: string
          wins?: number
        }
        Update: {
          draws?: number
          games_played?: number
          last_match_at?: string | null
          losses?: number
          mode?: string
          updated_at?: string
          user_id?: string
          wins?: number
        }
        Relationships: [
          {
            foreignKeyName: "user_mode_match_stats_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          country: string | null
          created_at: string
          email: string | null
          favorite_club: string | null
          id: string
          is_ai: boolean
          nickname: string | null
          onboarding_complete: boolean
          preferred_language: string
          role: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          country?: string | null
          created_at?: string
          email?: string | null
          favorite_club?: string | null
          id?: string
          is_ai?: boolean
          nickname?: string | null
          onboarding_complete?: boolean
          preferred_language?: string
          role?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          country?: string | null
          created_at?: string
          email?: string | null
          favorite_club?: string | null
          id?: string
          is_ai?: boolean
          nickname?: string | null
          onboarding_complete?: boolean
          preferred_language?: string
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      warmup_pair_bests: {
        Row: {
          best_score: number
          total_games: number
          updated_at: string
          user_a_id: string
          user_b_id: string
        }
        Insert: {
          best_score?: number
          total_games?: number
          updated_at?: string
          user_a_id: string
          user_b_id: string
        }
        Update: {
          best_score?: number
          total_games?: number
          updated_at?: string
          user_a_id?: string
          user_b_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "warmup_pair_bests_user_a_id_fkey"
            columns: ["user_a_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_pair_bests_user_b_id_fkey"
            columns: ["user_b_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      warmup_player_bests: {
        Row: {
          best_score: number
          total_games: number
          updated_at: string
          user_id: string
        }
        Insert: {
          best_score?: number
          total_games?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          best_score?: number
          total_games?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "warmup_player_bests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cleanup_ai_users: { Args: never; Returns: number }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
