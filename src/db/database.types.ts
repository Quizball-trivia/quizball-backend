export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
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
      announcements: {
        Row: {
          active_from: string | null
          active_to: string | null
          body: Json
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          title: Json
          type: string
          updated_at: string
        }
        Insert: {
          active_from?: string | null
          active_to?: string | null
          body: Json
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          title: Json
          type?: string
          updated_at?: string
        }
        Update: {
          active_from?: string | null
          active_to?: string | null
          body?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          title?: Json
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      auction_card_clues: {
        Row: {
          auction_card_id: string
          clue_en: string
          clue_ka: string
          clue_kind: string
          clue_order: number
          created_at: string
          id: string
          supported_fact_ids: string[]
          updated_at: string
        }
        Insert: {
          auction_card_id: string
          clue_en: string
          clue_ka: string
          clue_kind: string
          clue_order: number
          created_at?: string
          id?: string
          supported_fact_ids?: string[]
          updated_at?: string
        }
        Update: {
          auction_card_id?: string
          clue_en?: string
          clue_ka?: string
          clue_kind?: string
          clue_order?: number
          created_at?: string
          id?: string
          supported_fact_ids?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "auction_card_clues_auction_card_id_fkey"
            columns: ["auction_card_id"]
            isOneToOne: false
            referencedRelation: "auction_cards"
            referencedColumns: ["id"]
          },
        ]
      }
      auction_cards: {
        Row: {
          card_type: string
          created_at: string
          difficulty: string
          editor_notes: string | null
          generation_run_id: string | null
          generator_model: string | null
          id: string
          player_id: string
          position_group: string
          prompt_version: string | null
          published_at: string | null
          published_by: string | null
          starting_price_eur: number
          status: string
          true_value_eur: number
          updated_at: string
          value_type: string
          verification_notes: string | null
          verification_status: string
          verifier_model: string | null
        }
        Insert: {
          card_type?: string
          created_at?: string
          difficulty: string
          editor_notes?: string | null
          generation_run_id?: string | null
          generator_model?: string | null
          id?: string
          player_id: string
          position_group: string
          prompt_version?: string | null
          published_at?: string | null
          published_by?: string | null
          starting_price_eur: number
          status?: string
          true_value_eur: number
          updated_at?: string
          value_type: string
          verification_notes?: string | null
          verification_status?: string
          verifier_model?: string | null
        }
        Update: {
          card_type?: string
          created_at?: string
          difficulty?: string
          editor_notes?: string | null
          generation_run_id?: string | null
          generator_model?: string | null
          id?: string
          player_id?: string
          position_group?: string
          prompt_version?: string | null
          published_at?: string | null
          published_by?: string | null
          starting_price_eur?: number
          status?: string
          true_value_eur?: number
          updated_at?: string
          value_type?: string
          verification_notes?: string | null
          verification_status?: string
          verifier_model?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "auction_cards_generation_run_id_fkey"
            columns: ["generation_run_id"]
            isOneToOne: false
            referencedRelation: "llm_generation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auction_cards_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "auction_player_pricing"
            referencedColumns: ["football_player_id"]
          },
          {
            foreignKeyName: "auction_cards_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "football_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auction_cards_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "player_clue_generation_candidates"
            referencedColumns: ["football_player_id"]
          },
          {
            foreignKeyName: "auction_cards_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          metadata: Json | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          metadata?: Json | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          metadata?: Json | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_quiz_questions: {
        Row: {
          created_at: string
          difficulty: string
          display_order: number
          question_id: string
          quiz_slug: string
        }
        Insert: {
          created_at?: string
          difficulty: string
          display_order: number
          question_id: string
          quiz_slug: string
        }
        Update: {
          created_at?: string
          difficulty?: string
          display_order?: number
          question_id?: string
          quiz_slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_quiz_questions_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: true
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_quiz_questions_quiz_slug_fkey"
            columns: ["quiz_slug"]
            isOneToOne: false
            referencedRelation: "campaign_quizzes"
            referencedColumns: ["slug"]
          },
        ]
      }
      campaign_quiz_ratings: {
        Row: {
          created_at: string
          quiz_slug: string
          rating: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          quiz_slug: string
          rating: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          quiz_slug?: string
          rating?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_quiz_ratings_quiz_slug_fkey"
            columns: ["quiz_slug"]
            isOneToOne: false
            referencedRelation: "campaign_quizzes"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "campaign_quiz_ratings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_quizzes: {
        Row: {
          created_at: string
          slug: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          slug: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          slug?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      categories: {
        Row: {
          created_at: string
          created_by: string | null
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
          created_by?: string | null
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
          created_by?: string | null
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
            foreignKeyName: "categories_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "categories_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_challenge_completions: {
        Row: {
          challenge_day: string
          challenge_type: string
          coins_awarded: number
          completed_at: string
          id: string
          score: number
          user_id: string
          xp_awarded: number
        }
        Insert: {
          challenge_day: string
          challenge_type: string
          coins_awarded?: number
          completed_at?: string
          id?: string
          score?: number
          user_id: string
          xp_awarded?: number
        }
        Update: {
          challenge_day?: string
          challenge_type?: string
          coins_awarded?: number
          completed_at?: string
          id?: string
          score?: number
          user_id?: string
          xp_awarded?: number
        }
        Relationships: [
          {
            foreignKeyName: "daily_challenge_completions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_challenge_configs: {
        Row: {
          challenge_type: string
          coin_reward: number
          created_at: string
          is_active: boolean
          settings: Json
          show_on_home: boolean
          sort_order: number
          updated_at: string
          xp_reward: number
        }
        Insert: {
          challenge_type: string
          coin_reward?: number
          created_at?: string
          is_active?: boolean
          settings?: Json
          show_on_home?: boolean
          sort_order?: number
          updated_at?: string
          xp_reward?: number
        }
        Update: {
          challenge_type?: string
          coin_reward?: number
          created_at?: string
          is_active?: boolean
          settings?: Json
          show_on_home?: boolean
          sort_order?: number
          updated_at?: string
          xp_reward?: number
        }
        Relationships: []
      }
      event_awards: {
        Row: {
          awarded_at: string
          event_slug: string
          id: string
          place: number
          seen_at: string | null
          user_id: string
        }
        Insert: {
          awarded_at?: string
          event_slug: string
          id?: string
          place: number
          seen_at?: string | null
          user_id: string
        }
        Update: {
          awarded_at?: string
          event_slug?: string
          id?: string
          place?: number
          seen_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_awards_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
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
      football_player_market_values: {
        Row: {
          club_name: string | null
          created_at: string
          football_player_id: string | null
          id: string
          source: string
          source_payload: Json
          transfermarkt_id: string
          updated_at: string
          valuation_date: string
          value_eur: number
        }
        Insert: {
          club_name?: string | null
          created_at?: string
          football_player_id?: string | null
          id?: string
          source?: string
          source_payload: Json
          transfermarkt_id: string
          updated_at?: string
          valuation_date: string
          value_eur: number
        }
        Update: {
          club_name?: string | null
          created_at?: string
          football_player_id?: string | null
          id?: string
          source?: string
          source_payload?: Json
          transfermarkt_id?: string
          updated_at?: string
          valuation_date?: string
          value_eur?: number
        }
        Relationships: [
          {
            foreignKeyName: "football_player_market_values_football_player_id_fkey"
            columns: ["football_player_id"]
            isOneToOne: false
            referencedRelation: "auction_player_pricing"
            referencedColumns: ["football_player_id"]
          },
          {
            foreignKeyName: "football_player_market_values_football_player_id_fkey"
            columns: ["football_player_id"]
            isOneToOne: false
            referencedRelation: "football_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "football_player_market_values_football_player_id_fkey"
            columns: ["football_player_id"]
            isOneToOne: false
            referencedRelation: "player_clue_generation_candidates"
            referencedColumns: ["football_player_id"]
          },
        ]
      }
      football_players: {
        Row: {
          active_status: string
          created_at: string
          current_club: string | null
          current_value_eur: number | null
          data_quality_status: string
          date_of_birth: string | null
          display_name: Json
          fame_bucket: string | null
          fame_score: number | null
          id: string
          image_url: string | null
          name: string
          nationality: string | null
          nationality_code: string | null
          peak_value_eur: number | null
          position_group: string | null
          source_payload: Json
          transfermarkt_id: string | null
          updated_at: string
          wikidata_id: string | null
        }
        Insert: {
          active_status?: string
          created_at?: string
          current_club?: string | null
          current_value_eur?: number | null
          data_quality_status?: string
          date_of_birth?: string | null
          display_name?: Json
          fame_bucket?: string | null
          fame_score?: number | null
          id?: string
          image_url?: string | null
          name: string
          nationality?: string | null
          nationality_code?: string | null
          peak_value_eur?: number | null
          position_group?: string | null
          source_payload?: Json
          transfermarkt_id?: string | null
          updated_at?: string
          wikidata_id?: string | null
        }
        Update: {
          active_status?: string
          created_at?: string
          current_club?: string | null
          current_value_eur?: number | null
          data_quality_status?: string
          date_of_birth?: string | null
          display_name?: Json
          fame_bucket?: string | null
          fame_score?: number | null
          id?: string
          image_url?: string | null
          name?: string
          nationality?: string | null
          nationality_code?: string | null
          peak_value_eur?: number | null
          position_group?: string | null
          source_payload?: Json
          transfermarkt_id?: string | null
          updated_at?: string
          wikidata_id?: string | null
        }
        Relationships: []
      }
      friend_requests: {
        Row: {
          created_at: string
          id: string
          receiver_user_id: string
          sender_user_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          receiver_user_id: string
          sender_user_id: string
          status: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          receiver_user_id?: string
          sender_user_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "friend_requests_receiver_user_id_fkey"
            columns: ["receiver_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friend_requests_sender_user_id_fkey"
            columns: ["sender_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      friendships: {
        Row: {
          created_at: string
          id: string
          user_high_id: string
          user_low_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          user_high_id: string
          user_low_id: string
        }
        Update: {
          created_at?: string
          id?: string
          user_high_id?: string
          user_low_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "friendships_user_high_id_fkey"
            columns: ["user_high_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friendships_user_low_id_fkey"
            columns: ["user_low_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      import_runs: {
        Row: {
          created_at: string
          error_message: string | null
          finished_at: string | null
          id: string
          job_name: string
          metadata: Json
          rows_inserted: number
          rows_read: number
          rows_updated: number
          source: string
          started_at: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          job_name: string
          metadata?: Json
          rows_inserted?: number
          rows_read?: number
          rows_updated?: number
          source: string
          started_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          job_name?: string
          metadata?: Json
          rows_inserted?: number
          rows_read?: number
          rows_updated?: number
          source?: string
          started_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      llm_generation_runs: {
        Row: {
          auction_card_id: string | null
          cost_estimate: number | null
          created_at: string
          editor_rating: number | null
          editor_selected: boolean
          error_message: string | null
          id: string
          input_json: Json
          job_name: string
          latency_ms: number | null
          model_name: string
          model_role: string
          output_json: Json | null
          player_id: string | null
          prompt_version: string
          raw_output: string | null
          status: string
          token_usage: Json
          updated_at: string
        }
        Insert: {
          auction_card_id?: string | null
          cost_estimate?: number | null
          created_at?: string
          editor_rating?: number | null
          editor_selected?: boolean
          error_message?: string | null
          id?: string
          input_json?: Json
          job_name: string
          latency_ms?: number | null
          model_name: string
          model_role: string
          output_json?: Json | null
          player_id?: string | null
          prompt_version: string
          raw_output?: string | null
          status: string
          token_usage?: Json
          updated_at?: string
        }
        Update: {
          auction_card_id?: string | null
          cost_estimate?: number | null
          created_at?: string
          editor_rating?: number | null
          editor_selected?: boolean
          error_message?: string | null
          id?: string
          input_json?: Json
          job_name?: string
          latency_ms?: number | null
          model_name?: string
          model_role?: string
          output_json?: Json | null
          player_id?: string | null
          prompt_version?: string
          raw_output?: string | null
          status?: string
          token_usage?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "llm_generation_runs_auction_card_id_fkey"
            columns: ["auction_card_id"]
            isOneToOne: false
            referencedRelation: "auction_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_generation_runs_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "auction_player_pricing"
            referencedColumns: ["football_player_id"]
          },
          {
            foreignKeyName: "llm_generation_runs_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "football_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_generation_runs_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "player_clue_generation_candidates"
            referencedColumns: ["football_player_id"]
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
          ranked_context: Json | null
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
          ranked_context?: Json | null
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
          ranked_context?: Json | null
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
      lobby_challenge_invitations: {
        Row: {
          created_at: string
          expires_at: string
          from_user_id: string
          id: string
          lobby_id: string
          status: string
          to_user_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          from_user_id: string
          id?: string
          lobby_id: string
          status?: string
          to_user_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          from_user_id?: string
          id?: string
          lobby_id?: string
          status?: string
          to_user_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lobby_challenge_invitations_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lobby_challenge_invitations_lobby_id_fkey"
            columns: ["lobby_id"]
            isOneToOne: false
            referencedRelation: "lobbies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lobby_challenge_invitations_to_user_id_fkey"
            columns: ["to_user_id"]
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
          answer_payload: Json
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
          answer_payload?: Json
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
          answer_payload?: Json
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
      match_goal_events: {
        Row: {
          created_at: string
          half: number
          id: string
          is_penalty: boolean
          match_id: string
          phase_kind: string
          q_index: number | null
          seat: number
          user_id: string
        }
        Insert: {
          created_at?: string
          half: number
          id?: string
          is_penalty?: boolean
          match_id: string
          phase_kind: string
          q_index?: number | null
          seat: number
          user_id: string
        }
        Update: {
          created_at?: string
          half?: number
          id?: string
          is_penalty?: boolean
          match_id?: string
          phase_kind?: string
          q_index?: number | null
          seat?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_goal_events_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_goal_events_user_id_fkey"
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
          placement: number | null
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
          placement?: number | null
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
          placement?: number | null
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
          category_a_id: string | null
          category_b_id: string | null
          current_q_index: number
          ended_at: string | null
          id: string
          is_dev: boolean
          lobby_id: string | null
          mode: string
          ranked_context: Json | null
          started_at: string
          state_payload: Json | null
          status: string
          total_questions: number
          updated_at: string
          winner_user_id: string | null
        }
        Insert: {
          category_a_id?: string | null
          category_b_id?: string | null
          current_q_index?: number
          ended_at?: string | null
          id?: string
          is_dev?: boolean
          lobby_id?: string | null
          mode: string
          ranked_context?: Json | null
          started_at?: string
          state_payload?: Json | null
          status: string
          total_questions?: number
          updated_at?: string
          winner_user_id?: string | null
        }
        Update: {
          category_a_id?: string | null
          category_b_id?: string | null
          current_q_index?: number
          ended_at?: string | null
          id?: string
          is_dev?: boolean
          lobby_id?: string | null
          mode?: string
          ranked_context?: Json | null
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
      notifications: {
        Row: {
          body: Json | null
          created_at: string
          data: Json
          id: string
          read_at: string | null
          title: Json
          type: string
          user_id: string
        }
        Insert: {
          body?: Json | null
          created_at?: string
          data?: Json
          id?: string
          read_at?: string | null
          title: Json
          type: string
          user_id: string
        }
        Update: {
          body?: Json | null
          created_at?: string
          data?: Json
          id?: string
          read_at?: string | null
          title?: Json
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      player_clue_cards: {
        Row: {
          clue_1: string
          clue_2: string
          clue_3: string
          created_at: string
          difficulty: string
          evidence: Json
          football_player_id: string
          generation_model: string | null
          generation_provider: string | null
          id: string
          locale: string
          prompt_version: string
          rejection_reason: string | null
          review_notes: string | null
          source: string
          source_payload: Json
          status: string
          transfermarkt_id: number | null
          updated_at: string
        }
        Insert: {
          clue_1: string
          clue_2: string
          clue_3: string
          created_at?: string
          difficulty: string
          evidence?: Json
          football_player_id: string
          generation_model?: string | null
          generation_provider?: string | null
          id?: string
          locale: string
          prompt_version?: string
          rejection_reason?: string | null
          review_notes?: string | null
          source?: string
          source_payload?: Json
          status?: string
          transfermarkt_id?: number | null
          updated_at?: string
        }
        Update: {
          clue_1?: string
          clue_2?: string
          clue_3?: string
          created_at?: string
          difficulty?: string
          evidence?: Json
          football_player_id?: string
          generation_model?: string | null
          generation_provider?: string | null
          id?: string
          locale?: string
          prompt_version?: string
          rejection_reason?: string | null
          review_notes?: string | null
          source?: string
          source_payload?: Json
          status?: string
          transfermarkt_id?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_clue_cards_football_player_id_fkey"
            columns: ["football_player_id"]
            isOneToOne: false
            referencedRelation: "auction_player_pricing"
            referencedColumns: ["football_player_id"]
          },
          {
            foreignKeyName: "player_clue_cards_football_player_id_fkey"
            columns: ["football_player_id"]
            isOneToOne: false
            referencedRelation: "football_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_clue_cards_football_player_id_fkey"
            columns: ["football_player_id"]
            isOneToOne: false
            referencedRelation: "player_clue_generation_candidates"
            referencedColumns: ["football_player_id"]
          },
        ]
      }
      player_facts: {
        Row: {
          confidence: number | null
          created_at: string
          discovered_by: string
          evidence_quote: string | null
          fact_text_en: string
          fact_text_ka: string | null
          fact_type: string
          id: string
          player_id: string
          source_name: string | null
          source_url: string | null
          status: string
          updated_at: string
          verified_by_model: string | null
          verifier_notes: string | null
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          discovered_by: string
          evidence_quote?: string | null
          fact_text_en: string
          fact_text_ka?: string | null
          fact_type: string
          id?: string
          player_id: string
          source_name?: string | null
          source_url?: string | null
          status?: string
          updated_at?: string
          verified_by_model?: string | null
          verifier_notes?: string | null
        }
        Update: {
          confidence?: number | null
          created_at?: string
          discovered_by?: string
          evidence_quote?: string | null
          fact_text_en?: string
          fact_text_ka?: string | null
          fact_type?: string
          id?: string
          player_id?: string
          source_name?: string | null
          source_url?: string | null
          status?: string
          updated_at?: string
          verified_by_model?: string | null
          verifier_notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "player_facts_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "auction_player_pricing"
            referencedColumns: ["football_player_id"]
          },
          {
            foreignKeyName: "player_facts_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "football_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_facts_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "player_clue_generation_candidates"
            referencedColumns: ["football_player_id"]
          },
        ]
      }
      player_market_values: {
        Row: {
          created_at: string
          id: string
          import_run_id: string | null
          player_id: string
          source: string
          updated_at: string
          valuation_date: string
          value_eur: number
          value_type: string
        }
        Insert: {
          created_at?: string
          id?: string
          import_run_id?: string | null
          player_id: string
          source: string
          updated_at?: string
          valuation_date: string
          value_eur: number
          value_type: string
        }
        Update: {
          created_at?: string
          id?: string
          import_run_id?: string | null
          player_id?: string
          source?: string
          updated_at?: string
          valuation_date?: string
          value_eur?: number
          value_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_market_values_import_run_id_fkey"
            columns: ["import_run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_market_values_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "auction_player_pricing"
            referencedColumns: ["football_player_id"]
          },
          {
            foreignKeyName: "player_market_values_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "football_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_market_values_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "player_clue_generation_candidates"
            referencedColumns: ["football_player_id"]
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
          created_by: string | null
          difficulty: string
          explanation: Json | null
          id: string
          prompt: Json
          ranked_eligible: boolean
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          category_id: string
          created_at?: string
          created_by?: string | null
          difficulty: string
          explanation?: Json | null
          id?: string
          prompt: Json
          ranked_eligible?: boolean
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          category_id?: string
          created_at?: string
          created_by?: string | null
          difficulty?: string
          explanation?: Json | null
          id?: string
          prompt?: Json
          ranked_eligible?: boolean
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
          {
            foreignKeyName: "questions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ranked_early_forfeit_events: {
        Row: {
          created_at: string
          match_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          match_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          match_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ranked_early_forfeit_events_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ranked_early_forfeit_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ranked_profiles: {
        Row: {
          created_at: string
          current_win_streak: number
          last_ranked_match_at: string | null
          placement_perf_sum: number
          placement_played: number
          placement_points_against_sum: number
          placement_points_for_sum: number
          placement_required: number
          placement_seed_rp: number | null
          placement_status: string
          placement_wins: number
          rp: number
          tier: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_win_streak?: number
          last_ranked_match_at?: string | null
          placement_perf_sum?: number
          placement_played?: number
          placement_points_against_sum?: number
          placement_points_for_sum?: number
          placement_required?: number
          placement_seed_rp?: number | null
          placement_status?: string
          placement_wins?: number
          rp?: number
          tier: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_win_streak?: number
          last_ranked_match_at?: string | null
          placement_perf_sum?: number
          placement_played?: number
          placement_points_against_sum?: number
          placement_points_for_sum?: number
          placement_required?: number
          placement_seed_rp?: number | null
          placement_status?: string
          placement_wins?: number
          rp?: number
          tier?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ranked_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ranked_profiles_archive: {
        Row: {
          archived_at: string
          current_win_streak: number
          id: string
          last_ranked_match_at: string | null
          placement_perf_sum: number
          placement_played: number
          placement_points_against_sum: number
          placement_points_for_sum: number
          placement_required: number
          placement_seed_rp: number | null
          placement_status: string
          placement_wins: number
          reset_batch_id: string
          rp: number
          tier: string
          user_id: string
        }
        Insert: {
          archived_at?: string
          current_win_streak: number
          id?: string
          last_ranked_match_at?: string | null
          placement_perf_sum: number
          placement_played: number
          placement_points_against_sum: number
          placement_points_for_sum: number
          placement_required: number
          placement_seed_rp?: number | null
          placement_status: string
          placement_wins: number
          reset_batch_id: string
          rp: number
          tier: string
          user_id: string
        }
        Update: {
          archived_at?: string
          current_win_streak?: number
          id?: string
          last_ranked_match_at?: string | null
          placement_perf_sum?: number
          placement_played?: number
          placement_points_against_sum?: number
          placement_points_for_sum?: number
          placement_required?: number
          placement_seed_rp?: number | null
          placement_status?: string
          placement_wins?: number
          reset_batch_id?: string
          rp?: number
          tier?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ranked_profiles_archive_reset_batch_id_fkey"
            columns: ["reset_batch_id"]
            isOneToOne: false
            referencedRelation: "ranked_reset_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ranked_profiles_archive_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ranked_reset_batches: {
        Row: {
          completed_at: string | null
          id: string
          notes: string | null
          season_number: number | null
          started_at: string
          triggered_by: string | null
        }
        Insert: {
          completed_at?: string | null
          id?: string
          notes?: string | null
          season_number?: number | null
          started_at?: string
          triggered_by?: string | null
        }
        Update: {
          completed_at?: string | null
          id?: string
          notes?: string | null
          season_number?: number | null
          started_at?: string
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ranked_reset_batches_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ranked_rp_changes: {
        Row: {
          calculation_method: string
          coins_awarded: number
          created_at: string
          delta_rp: number
          id: string
          is_placement: boolean
          match_id: string
          new_rp: number
          old_rp: number
          opponent_is_ai: boolean
          opponent_user_id: string | null
          placement_anchor_rp: number | null
          placement_game_no: number | null
          placement_perf_score: number | null
          result: string
          user_id: string
        }
        Insert: {
          calculation_method: string
          coins_awarded?: number
          created_at?: string
          delta_rp: number
          id?: string
          is_placement?: boolean
          match_id: string
          new_rp: number
          old_rp: number
          opponent_is_ai: boolean
          opponent_user_id?: string | null
          placement_anchor_rp?: number | null
          placement_game_no?: number | null
          placement_perf_score?: number | null
          result: string
          user_id: string
        }
        Update: {
          calculation_method?: string
          coins_awarded?: number
          created_at?: string
          delta_rp?: number
          id?: string
          is_placement?: boolean
          match_id?: string
          new_rp?: number
          old_rp?: number
          opponent_is_ai?: boolean
          opponent_user_id?: string | null
          placement_anchor_rp?: number | null
          placement_game_no?: number | null
          placement_perf_score?: number | null
          result?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ranked_rp_changes_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ranked_rp_changes_opponent_user_id_fkey"
            columns: ["opponent_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ranked_rp_changes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ranked_rp_changes_archive: {
        Row: {
          archived_at: string
          calculation_method: string
          delta_rp: number
          id: string
          is_placement: boolean
          match_id: string
          new_rp: number
          old_rp: number
          opponent_is_ai: boolean
          opponent_user_id: string | null
          placement_anchor_rp: number | null
          placement_game_no: number | null
          placement_perf_score: number | null
          reset_batch_id: string
          result: string
          source_created_at: string
          user_id: string
        }
        Insert: {
          archived_at?: string
          calculation_method: string
          delta_rp: number
          id?: string
          is_placement: boolean
          match_id: string
          new_rp: number
          old_rp: number
          opponent_is_ai: boolean
          opponent_user_id?: string | null
          placement_anchor_rp?: number | null
          placement_game_no?: number | null
          placement_perf_score?: number | null
          reset_batch_id: string
          result: string
          source_created_at: string
          user_id: string
        }
        Update: {
          archived_at?: string
          calculation_method?: string
          delta_rp?: number
          id?: string
          is_placement?: boolean
          match_id?: string
          new_rp?: number
          old_rp?: number
          opponent_is_ai?: boolean
          opponent_user_id?: string | null
          placement_anchor_rp?: number | null
          placement_game_no?: number | null
          placement_perf_score?: number | null
          reset_batch_id?: string
          result?: string
          source_created_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ranked_rp_changes_archive_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ranked_rp_changes_archive_opponent_user_id_fkey"
            columns: ["opponent_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ranked_rp_changes_archive_reset_batch_id_fkey"
            columns: ["reset_batch_id"]
            isOneToOne: false
            referencedRelation: "ranked_reset_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ranked_rp_changes_archive_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_delivery_events: {
        Row: {
          created_at: string
          delivered_at: string | null
          destination: string
          error_code: number | null
          error_message: string | null
          id: string
          message_type: string
          provider: string
          raw_callback: Json | null
          reference: string
          sent_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          delivered_at?: string | null
          destination: string
          error_code?: number | null
          error_message?: string | null
          id?: string
          message_type?: string
          provider?: string
          raw_callback?: Json | null
          reference: string
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          delivered_at?: string | null
          destination?: string
          error_code?: number | null
          error_message?: string | null
          id?: string
          message_type?: string
          provider?: string
          raw_callback?: Json | null
          reference?: string
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      store_products: {
        Row: {
          created_at: string
          currency: string
          description: Json
          id: string
          is_active: boolean
          metadata: Json
          name: Json
          price_cents: number
          slug: string
          sort_order: number
          type: string
        }
        Insert: {
          created_at?: string
          currency?: string
          description?: Json
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: Json
          price_cents: number
          slug: string
          sort_order?: number
          type: string
        }
        Update: {
          created_at?: string
          currency?: string
          description?: Json
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: Json
          price_cents?: number
          slug?: string
          sort_order?: number
          type?: string
        }
        Relationships: []
      }
      store_purchases: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          fulfilled_at: string | null
          id: string
          product_id: string
          status: string
          stripe_checkout_id: string | null
          stripe_payment_intent: string | null
          user_id: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency?: string
          fulfilled_at?: string | null
          id?: string
          product_id: string
          status?: string
          stripe_checkout_id?: string | null
          stripe_payment_intent?: string | null
          user_id: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          fulfilled_at?: string | null
          id?: string
          product_id?: string
          status?: string
          stripe_checkout_id?: string | null
          stripe_payment_intent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "store_purchases_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "store_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_purchases_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      store_transaction_logs: {
        Row: {
          actor_user_id: string | null
          coins_delta: number
          created_at: string
          error_code: string | null
          error_message: string | null
          event_type: string
          id: string
          idempotency_key: string | null
          inventory_delta: Json
          metadata: Json
          outcome: string
          product_id: string | null
          purchase_id: string | null
          reason: string | null
          request_id: string | null
          stripe_checkout_id: string | null
          stripe_payment_intent: string | null
          tickets_delta: number
          user_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          coins_delta?: number
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          event_type: string
          id?: string
          idempotency_key?: string | null
          inventory_delta?: Json
          metadata?: Json
          outcome: string
          product_id?: string | null
          purchase_id?: string | null
          reason?: string | null
          request_id?: string | null
          stripe_checkout_id?: string | null
          stripe_payment_intent?: string | null
          tickets_delta?: number
          user_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          coins_delta?: number
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          event_type?: string
          id?: string
          idempotency_key?: string | null
          inventory_delta?: Json
          metadata?: Json
          outcome?: string
          product_id?: string | null
          purchase_id?: string | null
          reason?: string | null
          request_id?: string | null
          stripe_checkout_id?: string | null
          stripe_payment_intent?: string | null
          tickets_delta?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "store_transaction_logs_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_transaction_logs_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "store_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_transaction_logs_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "store_purchases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_transaction_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_achievements: {
        Row: {
          achievement_id: string
          created_at: string
          progress: number
          source_match_id: string | null
          unlocked_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          achievement_id: string
          created_at?: string
          progress?: number
          source_match_id?: string | null
          unlocked_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          achievement_id?: string
          created_at?: string
          progress?: number
          source_match_id?: string | null
          unlocked_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_achievements_source_match_id_fkey"
            columns: ["source_match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_achievements_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
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
      user_inventory: {
        Row: {
          acquired_at: string
          id: string
          product_id: string
          quantity: number
          user_id: string
        }
        Insert: {
          acquired_at?: string
          id?: string
          product_id: string
          quantity?: number
          user_id: string
        }
        Update: {
          acquired_at?: string
          id?: string
          product_id?: string
          quantity?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_inventory_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "store_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_inventory_user_id_fkey"
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
      user_objective_events: {
        Row: {
          created_at: string
          event_key: string
          id: string
          objective_id: string
          period_start: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_key: string
          id?: string
          objective_id: string
          period_start: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_key?: string
          id?: string
          objective_id?: string
          period_start?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_objective_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_objective_progress: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          metadata: Json
          objective_id: string
          period_end: string
          period_start: string
          period_type: string
          progress: number
          reward_coins: number
          reward_xp: number
          rewarded_at: string | null
          target: number
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          objective_id: string
          period_end: string
          period_start: string
          period_type: string
          progress?: number
          reward_coins?: number
          reward_xp?: number
          rewarded_at?: string | null
          target: number
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          objective_id?: string
          period_end?: string
          period_start?: string
          period_type?: string
          progress?: number
          reward_coins?: number
          reward_xp?: number
          rewarded_at?: string | null
          target?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_objective_progress_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_recent_categories: {
        Row: {
          category_id: string
          id: string
          mode: string
          played_at: string
          user_id: string
        }
        Insert: {
          category_id: string
          id?: string
          mode?: string
          played_at?: string
          user_id: string
        }
        Update: {
          category_id?: string
          id?: string
          mode?: string
          played_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_recent_categories_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_recent_categories_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_xp_events: {
        Row: {
          created_at: string
          id: string
          metadata: Json | null
          source_key: string
          source_type: string
          user_id: string
          xp_delta: number
        }
        Insert: {
          created_at?: string
          id?: string
          metadata?: Json | null
          source_key: string
          source_type: string
          user_id: string
          xp_delta: number
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json | null
          source_key?: string
          source_type?: string
          user_id?: string
          xp_delta?: number
        }
        Relationships: [
          {
            foreignKeyName: "user_xp_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_customization: Json | null
          avatar_url: string | null
          ban_metadata: Json | null
          ban_reason: string | null
          banned_at: string | null
          coins: number
          country: string | null
          created_at: string
          deleted_at: string | null
          deletion_requested_at: string | null
          early_forfeit_count: number
          early_forfeit_window_started_at: string | null
          email: string | null
          favorite_club: string | null
          id: string
          is_ai: boolean
          is_banned: boolean
          is_deleted: boolean
          is_seed: boolean
          nickname: string | null
          onboarding_complete: boolean
          pending_deletion_at: string | null
          phone_number: string | null
          phone_verified_at: string | null
          preferred_language: string
          role: string
          tickets: number
          tickets_refill_started_at: string | null
          total_xp: number
          updated_at: string
        }
        Insert: {
          avatar_customization?: Json | null
          avatar_url?: string | null
          ban_metadata?: Json | null
          ban_reason?: string | null
          banned_at?: string | null
          coins?: number
          country?: string | null
          created_at?: string
          deleted_at?: string | null
          deletion_requested_at?: string | null
          early_forfeit_count?: number
          early_forfeit_window_started_at?: string | null
          email?: string | null
          favorite_club?: string | null
          id?: string
          is_ai?: boolean
          is_banned?: boolean
          is_deleted?: boolean
          is_seed?: boolean
          nickname?: string | null
          onboarding_complete?: boolean
          pending_deletion_at?: string | null
          phone_number?: string | null
          phone_verified_at?: string | null
          preferred_language?: string
          role?: string
          tickets?: number
          tickets_refill_started_at?: string | null
          total_xp?: number
          updated_at?: string
        }
        Update: {
          avatar_customization?: Json | null
          avatar_url?: string | null
          ban_metadata?: Json | null
          ban_reason?: string | null
          banned_at?: string | null
          coins?: number
          country?: string | null
          created_at?: string
          deleted_at?: string | null
          deletion_requested_at?: string | null
          early_forfeit_count?: number
          early_forfeit_window_started_at?: string | null
          email?: string | null
          favorite_club?: string | null
          id?: string
          is_ai?: boolean
          is_banned?: boolean
          is_deleted?: boolean
          is_seed?: boolean
          nickname?: string | null
          onboarding_complete?: boolean
          pending_deletion_at?: string | null
          phone_number?: string | null
          phone_verified_at?: string | null
          preferred_language?: string
          role?: string
          tickets?: number
          tickets_refill_started_at?: string | null
          total_xp?: number
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
      auction_player_eligibility_summary: {
        Row: {
          current_value_count: number | null
          image_url_count: number | null
          missing_current_value_count: number | null
          normal_auction_eligible_count: number | null
          priced_but_not_normal_eligible_count: number | null
          total_players: number | null
          valid_position_group_count: number | null
        }
        Relationships: []
      }
      auction_player_pricing: {
        Row: {
          auction_price_confidence: string | null
          auction_price_eur: number | null
          auction_price_source: string | null
          current_club: string | null
          current_value_eur: number | null
          football_player_id: string | null
          image_url: string | null
          name: string | null
          normal_auction_eligible: boolean | null
          peak_value_eur: number | null
          position_group: string | null
          transfermarkt_id: string | null
        }
        Insert: {
          auction_price_confidence?: never
          auction_price_eur?: number | null
          auction_price_source?: never
          current_club?: string | null
          current_value_eur?: number | null
          football_player_id?: string | null
          image_url?: string | null
          name?: string | null
          normal_auction_eligible?: never
          peak_value_eur?: number | null
          position_group?: string | null
          transfermarkt_id?: string | null
        }
        Update: {
          auction_price_confidence?: never
          auction_price_eur?: number | null
          auction_price_source?: never
          current_club?: string | null
          current_value_eur?: number | null
          football_player_id?: string | null
          image_url?: string | null
          name?: string | null
          normal_auction_eligible?: never
          peak_value_eur?: number | null
          position_group?: string | null
          transfermarkt_id?: string | null
        }
        Relationships: []
      }
      player_clue_card_content_view: {
        Row: {
          active_status: string | null
          auction_price_eur: number | null
          clue_1: string | null
          clue_2: string | null
          clue_3: string | null
          clue_card_id: string | null
          created_at: string | null
          current_club: string | null
          current_value_eur: number | null
          difficulty: string | null
          evidence: Json | null
          football_player_id: string | null
          generation_model: string | null
          generation_provider: string | null
          image_url: string | null
          locale: string | null
          name: string | null
          nationality: string | null
          peak_value_eur: number | null
          position_group: string | null
          position_label_en: string | null
          position_label_ka: string | null
          prompt_version: string | null
          review_notes: string | null
          source: string | null
          starting_price_eur: number | null
          status: string | null
          transfermarkt_id: number | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "player_clue_cards_football_player_id_fkey"
            columns: ["football_player_id"]
            isOneToOne: false
            referencedRelation: "auction_player_pricing"
            referencedColumns: ["football_player_id"]
          },
          {
            foreignKeyName: "player_clue_cards_football_player_id_fkey"
            columns: ["football_player_id"]
            isOneToOne: false
            referencedRelation: "football_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_clue_cards_football_player_id_fkey"
            columns: ["football_player_id"]
            isOneToOne: false
            referencedRelation: "player_clue_generation_candidates"
            referencedColumns: ["football_player_id"]
          },
        ]
      }
      player_clue_generation_candidates: {
        Row: {
          auction_price_confidence: string | null
          auction_price_eur: number | null
          auction_price_source: string | null
          current_club: string | null
          current_value_eur: number | null
          date_of_birth: string | null
          difficulty: string | null
          eligible_for_clue_generation: boolean | null
          football_player_id: string | null
          image_url: string | null
          name: string | null
          nationality: string | null
          peak_value_eur: number | null
          position_group: string | null
          position_label_en: string | null
          position_label_ka: string | null
          transfermarkt_id: number | null
          value_bucket: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      cleanup_ai_users: { Args: never; Returns: number }
      finalize_pending_account_deletions: { Args: never; Returns: number }
      refill_tickets_global: { Args: never; Returns: number }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      simulate_leaderboard_movement: { Args: never; Returns: undefined }
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
