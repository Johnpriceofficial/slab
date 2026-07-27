// contracts/database.types.ts
// Generated read-only from production Supabase schema (project rcbwemkfcefarqnlgrmv)
// Schema state: 65 migrations, 20260709000000..20260904000000 — repo commit ba3953fdb68c31435c7dac732f67d8d53aa2adcb
// Generated 2026-07-27 via Supabase type generation. DO NOT EDIT BY HAND.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      ai_analysis_runs: {
        Row: {
          analysis_type: string;
          created_at: string;
          error_code: string | null;
          id: string;
          input_image_ids: string[];
          latency_ms: number | null;
          model: string;
          owner_id: string | null;
          provider: string;
          request_id: string | null;
          schema_version: string;
          slab_id: string | null;
          status: string;
          structured_result: Json | null;
          usage: Json | null;
        };
        Insert: {
          analysis_type: string;
          created_at?: string;
          error_code?: string | null;
          id?: string;
          input_image_ids?: string[];
          latency_ms?: number | null;
          model: string;
          owner_id?: string | null;
          provider: string;
          request_id?: string | null;
          schema_version: string;
          slab_id?: string | null;
          status: string;
          structured_result?: Json | null;
          usage?: Json | null;
        };
        Update: {
          analysis_type?: string;
          created_at?: string;
          error_code?: string | null;
          id?: string;
          input_image_ids?: string[];
          latency_ms?: number | null;
          model?: string;
          owner_id?: string | null;
          provider?: string;
          request_id?: string | null;
          schema_version?: string;
          slab_id?: string | null;
          status?: string;
          structured_result?: Json | null;
          usage?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "ai_analysis_runs_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_field_evidence: {
        Row: {
          alternatives: Json;
          analysis_run_id: string;
          bounding_box: Json | null;
          confidence: number | null;
          created_at: string;
          derivative_id: string | null;
          field_name: string;
          id: string;
          image_id: string | null;
          normalized_value: string | null;
          owner_id: string | null;
          readability: string | null;
          slab_id: string | null;
          value: string | null;
        };
        Insert: {
          alternatives?: Json;
          analysis_run_id: string;
          bounding_box?: Json | null;
          confidence?: number | null;
          created_at?: string;
          derivative_id?: string | null;
          field_name: string;
          id?: string;
          image_id?: string | null;
          normalized_value?: string | null;
          owner_id?: string | null;
          readability?: string | null;
          slab_id?: string | null;
          value?: string | null;
        };
        Update: {
          alternatives?: Json;
          analysis_run_id?: string;
          bounding_box?: Json | null;
          confidence?: number | null;
          created_at?: string;
          derivative_id?: string | null;
          field_name?: string;
          id?: string;
          image_id?: string | null;
          normalized_value?: string | null;
          owner_id?: string | null;
          readability?: string | null;
          slab_id?: string | null;
          value?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ai_field_evidence_analysis_run_id_fkey";
            columns: ["analysis_run_id"];
            isOneToOne: false;
            referencedRelation: "ai_analysis_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_field_evidence_derivative_id_fkey";
            columns: ["derivative_id"];
            isOneToOne: false;
            referencedRelation: "image_derivatives";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_field_evidence_image_id_fkey";
            columns: ["image_id"];
            isOneToOne: false;
            referencedRelation: "slab_images";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_field_evidence_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      api_daily_usage: {
        Row: {
          bucket: string;
          count: number;
          usage_date: string;
        };
        Insert: {
          bucket: string;
          count?: number;
          usage_date?: string;
        };
        Update: {
          bucket?: string;
          count?: number;
          usage_date?: string;
        };
        Relationships: [];
      };
      api_rate_limits: {
        Row: {
          bucket: string;
          last_reserved_at: string;
          min_interval_ms: number;
          updated_at: string;
        };
        Insert: {
          bucket: string;
          last_reserved_at?: string;
          min_interval_ms?: number;
          updated_at?: string;
        };
        Update: {
          bucket?: string;
          last_reserved_at?: string;
          min_interval_ms?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      api_user_daily_usage: {
        Row: {
          bucket: string;
          count: number;
          created_at: string;
          updated_at: string;
          usage_date: string;
          user_id: string;
        };
        Insert: {
          bucket: string;
          count?: number;
          created_at?: string;
          updated_at?: string;
          usage_date?: string;
          user_id: string;
        };
        Update: {
          bucket?: string;
          count?: number;
          created_at?: string;
          updated_at?: string;
          usage_date?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      audit_log: {
        Row: {
          action: string;
          actor_user_id: string | null;
          created_at: string;
          detail: Json;
          entity_id: string | null;
          entity_type: string;
          id: number;
          owner_id: string | null;
          source: string;
        };
        Insert: {
          action: string;
          actor_user_id?: string | null;
          created_at?: string;
          detail?: Json;
          entity_id?: string | null;
          entity_type: string;
          id?: never;
          owner_id?: string | null;
          source: string;
        };
        Update: {
          action?: string;
          actor_user_id?: string | null;
          created_at?: string;
          detail?: Json;
          entity_id?: string | null;
          entity_type?: string;
          id?: never;
          owner_id?: string | null;
          source?: string;
        };
        Relationships: [];
      };
      builder_approvals: {
        Row: {
          confirmation_phrase: string | null;
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          decision: string;
          id: string;
          requested_action: string;
          requested_by: string | null;
          risk: string;
          run_id: string;
        };
        Insert: {
          confirmation_phrase?: string | null;
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision?: string;
          id?: string;
          requested_action: string;
          requested_by?: string | null;
          risk: string;
          run_id: string;
        };
        Update: {
          confirmation_phrase?: string | null;
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision?: string;
          id?: string;
          requested_action?: string;
          requested_by?: string | null;
          risk?: string;
          run_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "builder_approvals_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "builder_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      builder_audit_events: {
        Row: {
          actor: string | null;
          correlation_id: string;
          created_at: string;
          detail: Json;
          event_type: string;
          id: string;
          run_id: string | null;
        };
        Insert: {
          actor?: string | null;
          correlation_id: string;
          created_at?: string;
          detail?: Json;
          event_type: string;
          id?: string;
          run_id?: string | null;
        };
        Update: {
          actor?: string | null;
          correlation_id?: string;
          created_at?: string;
          detail?: Json;
          event_type?: string;
          id?: string;
          run_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "builder_audit_events_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "builder_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      builder_connections: {
        Row: {
          created_at: string;
          id: string;
          label: string;
          provider: string;
          risk_ceiling: string;
          scopes: string[];
          secret_ref: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          label: string;
          provider: string;
          risk_ceiling?: string;
          scopes?: string[];
          secret_ref?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          label?: string;
          provider?: string;
          risk_ceiling?: string;
          scopes?: string[];
          secret_ref?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      builder_policy_rules: {
        Row: {
          created_at: string;
          decision: string;
          enabled: boolean;
          environment: string;
          id: string;
          provider: string;
          risk: string;
        };
        Insert: {
          created_at?: string;
          decision: string;
          enabled?: boolean;
          environment: string;
          id?: string;
          provider: string;
          risk: string;
        };
        Update: {
          created_at?: string;
          decision?: string;
          enabled?: boolean;
          environment?: string;
          id?: string;
          provider?: string;
          risk?: string;
        };
        Relationships: [];
      };
      builder_runs: {
        Row: {
          correlation_id: string;
          created_at: string;
          environment: string;
          id: string;
          instruction: string;
          project: string;
          requested_by: string | null;
          session_mode: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          correlation_id: string;
          created_at?: string;
          environment?: string;
          id?: string;
          instruction: string;
          project: string;
          requested_by?: string | null;
          session_mode?: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          correlation_id?: string;
          created_at?: string;
          environment?: string;
          id?: string;
          instruction?: string;
          project?: string;
          requested_by?: string | null;
          session_mode?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      builder_steps: {
        Row: {
          agent: string;
          created_at: string;
          id: string;
          idx: number;
          run_id: string;
          status: string;
          title: string;
        };
        Insert: {
          agent: string;
          created_at?: string;
          id?: string;
          idx: number;
          run_id: string;
          status?: string;
          title: string;
        };
        Update: {
          agent?: string;
          created_at?: string;
          id?: string;
          idx?: number;
          run_id?: string;
          status?: string;
          title?: string;
        };
        Relationships: [
          {
            foreignKeyName: "builder_steps_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "builder_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      builder_tool_calls: {
        Row: {
          acting_user: string | null;
          action: string;
          agent: string;
          approval_id: string | null;
          commit_sha: string | null;
          completed_at: string | null;
          correlation_id: string;
          decision: string;
          id: string;
          provider: string;
          risk: string;
          run_id: string;
          sanitized_input: Json;
          sanitized_result: Json | null;
          started_at: string;
          step_id: string | null;
        };
        Insert: {
          acting_user?: string | null;
          action: string;
          agent: string;
          approval_id?: string | null;
          commit_sha?: string | null;
          completed_at?: string | null;
          correlation_id: string;
          decision: string;
          id?: string;
          provider: string;
          risk: string;
          run_id: string;
          sanitized_input?: Json;
          sanitized_result?: Json | null;
          started_at?: string;
          step_id?: string | null;
        };
        Update: {
          acting_user?: string | null;
          action?: string;
          agent?: string;
          approval_id?: string | null;
          commit_sha?: string | null;
          completed_at?: string | null;
          correlation_id?: string;
          decision?: string;
          id?: string;
          provider?: string;
          risk?: string;
          run_id?: string;
          sanitized_input?: Json;
          sanitized_result?: Json | null;
          started_at?: string;
          step_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "builder_tool_calls_approval_id_fkey";
            columns: ["approval_id"];
            isOneToOne: false;
            referencedRelation: "builder_approvals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "builder_tool_calls_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "builder_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "builder_tool_calls_step_id_fkey";
            columns: ["step_id"];
            isOneToOne: false;
            referencedRelation: "builder_steps";
            referencedColumns: ["id"];
          },
        ];
      };
      card_scan_reviews: {
        Row: {
          corrected_data: Json | null;
          created_at: string;
          created_by: string;
          id: string;
          proposed_data: Json;
          resolved_at: string | null;
          resolved_by: string | null;
          review_reason: string;
          scan_id: string;
          status: string;
        };
        Insert: {
          corrected_data?: Json | null;
          created_at?: string;
          created_by: string;
          id?: string;
          proposed_data: Json;
          resolved_at?: string | null;
          resolved_by?: string | null;
          review_reason: string;
          scan_id: string;
          status?: string;
        };
        Update: {
          corrected_data?: Json | null;
          created_at?: string;
          created_by?: string;
          id?: string;
          proposed_data?: Json;
          resolved_at?: string | null;
          resolved_by?: string | null;
          review_reason?: string;
          scan_id?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "card_scan_reviews_scan_id_fkey";
            columns: ["scan_id"];
            isOneToOne: true;
            referencedRelation: "card_scans";
            referencedColumns: ["id"];
          },
        ];
      };
      card_scans: {
        Row: {
          byte_size: number;
          card_name: string | null;
          card_number: string | null;
          condition_issues: Json;
          confidence: number | null;
          created_at: string;
          created_by: string;
          error_code: string | null;
          id: string;
          image_sha256: string;
          image_storage_path: string;
          latency_ms: number | null;
          mime_type: string;
          model: string | null;
          openai_request_id: string | null;
          openai_usage: Json | null;
          rarity: string | null;
          raw_result: Json | null;
          schema_version: string;
          set_name: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          byte_size: number;
          card_name?: string | null;
          card_number?: string | null;
          condition_issues?: Json;
          confidence?: number | null;
          created_at?: string;
          created_by: string;
          error_code?: string | null;
          id?: string;
          image_sha256: string;
          image_storage_path: string;
          latency_ms?: number | null;
          mime_type: string;
          model?: string | null;
          openai_request_id?: string | null;
          openai_usage?: Json | null;
          rarity?: string | null;
          raw_result?: Json | null;
          schema_version?: string;
          set_name?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          byte_size?: number;
          card_name?: string | null;
          card_number?: string | null;
          condition_issues?: Json;
          confidence?: number | null;
          created_at?: string;
          created_by?: string;
          error_code?: string | null;
          id?: string;
          image_sha256?: string;
          image_storage_path?: string;
          latency_ms?: number | null;
          mime_type?: string;
          model?: string | null;
          openai_request_id?: string | null;
          openai_usage?: Json | null;
          rarity?: string | null;
          raw_result?: Json | null;
          schema_version?: string;
          set_name?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      cards: {
        Row: {
          back_image_path: string | null;
          card_name: string;
          card_name_normalized: string | null;
          card_number: string;
          card_number_normalized: string | null;
          condition_issues: Json;
          condition_notes: string | null;
          created_at: string;
          created_by: string;
          id: string;
          identification_confidence: number;
          inventory_code: string | null;
          inventory_prefix: string;
          inventory_sequence: number;
          inventory_status: string;
          rarity: string | null;
          scan_image_path: string;
          set_name: string;
          set_name_normalized: string | null;
          source_scan_id: string;
          updated_at: string;
        };
        Insert: {
          back_image_path?: string | null;
          card_name: string;
          card_name_normalized?: string | null;
          card_number: string;
          card_number_normalized?: string | null;
          condition_issues?: Json;
          condition_notes?: string | null;
          created_at?: string;
          created_by: string;
          id?: string;
          identification_confidence: number;
          inventory_code?: string | null;
          inventory_prefix?: string;
          inventory_sequence: number;
          inventory_status?: string;
          rarity?: string | null;
          scan_image_path: string;
          set_name: string;
          set_name_normalized?: string | null;
          source_scan_id: string;
          updated_at?: string;
        };
        Update: {
          back_image_path?: string | null;
          card_name?: string;
          card_name_normalized?: string | null;
          card_number?: string;
          card_number_normalized?: string | null;
          condition_issues?: Json;
          condition_notes?: string | null;
          created_at?: string;
          created_by?: string;
          id?: string;
          identification_confidence?: number;
          inventory_code?: string | null;
          inventory_prefix?: string;
          inventory_sequence?: number;
          inventory_status?: string;
          rarity?: string | null;
          scan_image_path?: string;
          set_name?: string;
          set_name_normalized?: string | null;
          source_scan_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "cards_source_scan_id_fkey";
            columns: ["source_scan_id"];
            isOneToOne: true;
            referencedRelation: "card_scans";
            referencedColumns: ["id"];
          },
        ];
      };
      cgc_population_cards: {
        Row: {
          autograph: boolean | null;
          card_name: string | null;
          card_number: string | null;
          cgc_card_id: number | null;
          count_aa: number | null;
          count_au: number | null;
          count_ex_nm_6: number | null;
          count_ex_nm_plus_6_5: number | null;
          count_gem_mint_10: number | null;
          count_lower_grades: number | null;
          count_mint_9: number | null;
          count_mint_plus_9_5: number | null;
          count_nm_7: number | null;
          count_nm_mint_8: number | null;
          count_nm_mint_plus_8_5: number | null;
          count_nm_plus_7_5: number | null;
          count_perfect_10: number | null;
          count_pristine_10: number | null;
          created_at: string;
          id: string;
          memorabilia: boolean | null;
          normalized_card_name: string | null;
          normalized_card_number: string | null;
          normalized_variant: string | null;
          parallel_or_variant: string | null;
          population_set_id: string | null;
          raw_record: Json | null;
          report_url: string | null;
          source_retrieved_at: string | null;
          total_graded: number | null;
          updated_at: string;
        };
        Insert: {
          autograph?: boolean | null;
          card_name?: string | null;
          card_number?: string | null;
          cgc_card_id?: number | null;
          count_aa?: number | null;
          count_au?: number | null;
          count_ex_nm_6?: number | null;
          count_ex_nm_plus_6_5?: number | null;
          count_gem_mint_10?: number | null;
          count_lower_grades?: number | null;
          count_mint_9?: number | null;
          count_mint_plus_9_5?: number | null;
          count_nm_7?: number | null;
          count_nm_mint_8?: number | null;
          count_nm_mint_plus_8_5?: number | null;
          count_nm_plus_7_5?: number | null;
          count_perfect_10?: number | null;
          count_pristine_10?: number | null;
          created_at?: string;
          id?: string;
          memorabilia?: boolean | null;
          normalized_card_name?: string | null;
          normalized_card_number?: string | null;
          normalized_variant?: string | null;
          parallel_or_variant?: string | null;
          population_set_id?: string | null;
          raw_record?: Json | null;
          report_url?: string | null;
          source_retrieved_at?: string | null;
          total_graded?: number | null;
          updated_at?: string;
        };
        Update: {
          autograph?: boolean | null;
          card_name?: string | null;
          card_number?: string | null;
          cgc_card_id?: number | null;
          count_aa?: number | null;
          count_au?: number | null;
          count_ex_nm_6?: number | null;
          count_ex_nm_plus_6_5?: number | null;
          count_gem_mint_10?: number | null;
          count_lower_grades?: number | null;
          count_mint_9?: number | null;
          count_mint_plus_9_5?: number | null;
          count_nm_7?: number | null;
          count_nm_mint_8?: number | null;
          count_nm_mint_plus_8_5?: number | null;
          count_nm_plus_7_5?: number | null;
          count_perfect_10?: number | null;
          count_pristine_10?: number | null;
          created_at?: string;
          id?: string;
          memorabilia?: boolean | null;
          normalized_card_name?: string | null;
          normalized_card_number?: string | null;
          normalized_variant?: string | null;
          parallel_or_variant?: string | null;
          population_set_id?: string | null;
          raw_record?: Json | null;
          report_url?: string | null;
          source_retrieved_at?: string | null;
          total_graded?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "cgc_population_cards_population_set_id_fkey";
            columns: ["population_set_id"];
            isOneToOne: false;
            referencedRelation: "cgc_population_sets";
            referencedColumns: ["id"];
          },
        ];
      };
      cgc_population_import_runs: {
        Row: {
          apify_run_id: string | null;
          completed_at: string | null;
          created_at: string;
          dataset_id: string | null;
          error: string | null;
          id: string;
          input: Json | null;
          item_count: number | null;
          mode: string | null;
          requested_by: string | null;
          set_id: string | null;
          started_at: string | null;
          status: string;
        };
        Insert: {
          apify_run_id?: string | null;
          completed_at?: string | null;
          created_at?: string;
          dataset_id?: string | null;
          error?: string | null;
          id?: string;
          input?: Json | null;
          item_count?: number | null;
          mode?: string | null;
          requested_by?: string | null;
          set_id?: string | null;
          started_at?: string | null;
          status?: string;
        };
        Update: {
          apify_run_id?: string | null;
          completed_at?: string | null;
          created_at?: string;
          dataset_id?: string | null;
          error?: string | null;
          id?: string;
          input?: Json | null;
          item_count?: number | null;
          mode?: string | null;
          requested_by?: string | null;
          set_id?: string | null;
          started_at?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "cgc_population_import_runs_set_id_fkey";
            columns: ["set_id"];
            isOneToOne: false;
            referencedRelation: "cgc_population_sets";
            referencedColumns: ["id"];
          },
        ];
      };
      cgc_population_sets: {
        Row: {
          brand: string | null;
          category: string | null;
          cgc_set_id: number | null;
          created_at: string;
          id: string;
          last_apify_run_id: string | null;
          last_dataset_id: string | null;
          last_refreshed_at: string | null;
          normalized_set_name: string | null;
          refresh_error: string | null;
          refresh_status: string | null;
          report_url: string | null;
          set_name: string | null;
          subcategory: string | null;
          updated_at: string;
          year: string | null;
        };
        Insert: {
          brand?: string | null;
          category?: string | null;
          cgc_set_id?: number | null;
          created_at?: string;
          id?: string;
          last_apify_run_id?: string | null;
          last_dataset_id?: string | null;
          last_refreshed_at?: string | null;
          normalized_set_name?: string | null;
          refresh_error?: string | null;
          refresh_status?: string | null;
          report_url?: string | null;
          set_name?: string | null;
          subcategory?: string | null;
          updated_at?: string;
          year?: string | null;
        };
        Update: {
          brand?: string | null;
          category?: string | null;
          cgc_set_id?: number | null;
          created_at?: string;
          id?: string;
          last_apify_run_id?: string | null;
          last_dataset_id?: string | null;
          last_refreshed_at?: string | null;
          normalized_set_name?: string | null;
          refresh_error?: string | null;
          refresh_status?: string | null;
          report_url?: string | null;
          set_name?: string | null;
          subcategory?: string | null;
          updated_at?: string;
          year?: string | null;
        };
        Relationships: [];
      };
      customer_profiles: {
        Row: {
          account_status: string;
          created_at: string;
          daily_scan_limit: number;
          id: string;
          plan: string;
          updated_at: string;
        };
        Insert: {
          account_status?: string;
          created_at?: string;
          daily_scan_limit?: number;
          id: string;
          plan?: string;
          updated_at?: string;
        };
        Update: {
          account_status?: string;
          created_at?: string;
          daily_scan_limit?: number;
          id?: string;
          plan?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      ebay_accounts: {
        Row: {
          authorization_expires_at: string | null;
          connected_at: string | null;
          connection_status: string;
          created_at: string;
          display_label: string | null;
          ebay_user_id: string;
          id: string;
          last_synced_at: string | null;
          marketplace_id: string | null;
          privilege_status: string | null;
          updated_at: string;
        };
        Insert: {
          authorization_expires_at?: string | null;
          connected_at?: string | null;
          connection_status?: string;
          created_at?: string;
          display_label?: string | null;
          ebay_user_id: string;
          id?: string;
          last_synced_at?: string | null;
          marketplace_id?: string | null;
          privilege_status?: string | null;
          updated_at?: string;
        };
        Update: {
          authorization_expires_at?: string | null;
          connected_at?: string | null;
          connection_status?: string;
          created_at?: string;
          display_label?: string | null;
          ebay_user_id?: string;
          id?: string;
          last_synced_at?: string | null;
          marketplace_id?: string | null;
          privilege_status?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      ebay_api_runs: {
        Row: {
          created_at: string;
          ebay_account_id: string | null;
          error_code: string | null;
          http_status: number | null;
          id: string;
          latency_ms: number | null;
          operation: string;
          request_id: string | null;
          status: string;
        };
        Insert: {
          created_at?: string;
          ebay_account_id?: string | null;
          error_code?: string | null;
          http_status?: number | null;
          id?: string;
          latency_ms?: number | null;
          operation: string;
          request_id?: string | null;
          status: string;
        };
        Update: {
          created_at?: string;
          ebay_account_id?: string | null;
          error_code?: string | null;
          http_status?: number | null;
          id?: string;
          latency_ms?: number | null;
          operation?: string;
          request_id?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ebay_api_runs_ebay_account_id_fkey";
            columns: ["ebay_account_id"];
            isOneToOne: false;
            referencedRelation: "ebay_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      ebay_business_policies: {
        Row: {
          ebay_account_id: string;
          id: string;
          last_synced_at: string | null;
          marketplace_id: string | null;
          name: string | null;
          policy_id: string;
          policy_type: string;
        };
        Insert: {
          ebay_account_id: string;
          id?: string;
          last_synced_at?: string | null;
          marketplace_id?: string | null;
          name?: string | null;
          policy_id: string;
          policy_type: string;
        };
        Update: {
          ebay_account_id?: string;
          id?: string;
          last_synced_at?: string | null;
          marketplace_id?: string | null;
          name?: string | null;
          policy_id?: string;
          policy_type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ebay_business_policies_ebay_account_id_fkey";
            columns: ["ebay_account_id"];
            isOneToOne: false;
            referencedRelation: "ebay_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      ebay_inventory_locations: {
        Row: {
          ebay_account_id: string;
          id: string;
          last_synced_at: string | null;
          merchant_location_key: string;
          raw_enum_value: string | null;
          status: string | null;
        };
        Insert: {
          ebay_account_id: string;
          id?: string;
          last_synced_at?: string | null;
          merchant_location_key: string;
          raw_enum_value?: string | null;
          status?: string | null;
        };
        Update: {
          ebay_account_id?: string;
          id?: string;
          last_synced_at?: string | null;
          merchant_location_key?: string;
          raw_enum_value?: string | null;
          status?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ebay_inventory_locations_ebay_account_id_fkey";
            columns: ["ebay_account_id"];
            isOneToOne: false;
            referencedRelation: "ebay_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      ebay_listing_intents: {
        Row: {
          created_at: string;
          ebay_account_id: string;
          fingerprint: string | null;
          fingerprint_version: number | null;
          id: string;
          image_manifest: Json | null;
          image_verification_method: string | null;
          images_submitted_at: string | null;
          intended_state: Json | null;
          last_error: string | null;
          listing_id: string | null;
          offer_id: string | null;
          provider_image_evidence: Json | null;
          provider_verified_at: string | null;
          sku: string;
          slab_id: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          ebay_account_id: string;
          fingerprint?: string | null;
          fingerprint_version?: number | null;
          id?: string;
          image_manifest?: Json | null;
          image_verification_method?: string | null;
          images_submitted_at?: string | null;
          intended_state?: Json | null;
          last_error?: string | null;
          listing_id?: string | null;
          offer_id?: string | null;
          provider_image_evidence?: Json | null;
          provider_verified_at?: string | null;
          sku: string;
          slab_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          ebay_account_id?: string;
          fingerprint?: string | null;
          fingerprint_version?: number | null;
          id?: string;
          image_manifest?: Json | null;
          image_verification_method?: string | null;
          images_submitted_at?: string | null;
          intended_state?: Json | null;
          last_error?: string | null;
          listing_id?: string | null;
          offer_id?: string | null;
          provider_image_evidence?: Json | null;
          provider_verified_at?: string | null;
          sku?: string;
          slab_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ebay_listing_intents_ebay_account_id_fkey";
            columns: ["ebay_account_id"];
            isOneToOne: false;
            referencedRelation: "ebay_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ebay_listing_intents_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      ebay_listing_mappings: {
        Row: {
          asking_price_cents: number | null;
          created_at: string;
          currency: string;
          ebay_account_id: string;
          id: string;
          last_synced_at: string | null;
          listing_id: string | null;
          listing_status: string;
          offer_id: string | null;
          sku: string;
          slab_id: string;
        };
        Insert: {
          asking_price_cents?: number | null;
          created_at?: string;
          currency?: string;
          ebay_account_id: string;
          id?: string;
          last_synced_at?: string | null;
          listing_id?: string | null;
          listing_status?: string;
          offer_id?: string | null;
          sku: string;
          slab_id: string;
        };
        Update: {
          asking_price_cents?: number | null;
          created_at?: string;
          currency?: string;
          ebay_account_id?: string;
          id?: string;
          last_synced_at?: string | null;
          listing_id?: string | null;
          listing_status?: string;
          offer_id?: string | null;
          sku?: string;
          slab_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ebay_listing_mappings_ebay_account_id_fkey";
            columns: ["ebay_account_id"];
            isOneToOne: false;
            referencedRelation: "ebay_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ebay_listing_mappings_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      ebay_notifications: {
        Row: {
          ebay_account_id: string | null;
          id: string;
          notification_id: string;
          payload_sha256: string;
          processed_at: string | null;
          received_at: string;
          status: string;
          topic: string;
        };
        Insert: {
          ebay_account_id?: string | null;
          id?: string;
          notification_id: string;
          payload_sha256: string;
          processed_at?: string | null;
          received_at?: string;
          status: string;
          topic: string;
        };
        Update: {
          ebay_account_id?: string | null;
          id?: string;
          notification_id?: string;
          payload_sha256?: string;
          processed_at?: string | null;
          received_at?: string;
          status?: string;
          topic?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ebay_notifications_ebay_account_id_fkey";
            columns: ["ebay_account_id"];
            isOneToOne: false;
            referencedRelation: "ebay_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      ebay_sync_cursors: {
        Row: {
          cursor_value: string | null;
          ebay_account_id: string;
          id: string;
          last_synced_at: string | null;
          next_sync_at: string | null;
          resource_type: string;
        };
        Insert: {
          cursor_value?: string | null;
          ebay_account_id: string;
          id?: string;
          last_synced_at?: string | null;
          next_sync_at?: string | null;
          resource_type: string;
        };
        Update: {
          cursor_value?: string | null;
          ebay_account_id?: string;
          id?: string;
          last_synced_at?: string | null;
          next_sync_at?: string | null;
          resource_type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ebay_sync_cursors_ebay_account_id_fkey";
            columns: ["ebay_account_id"];
            isOneToOne: false;
            referencedRelation: "ebay_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      ebay_sync_state: {
        Row: {
          durable_total: number | null;
          ebay_account_id: string;
          high_watermark_at: string | null;
          id: string;
          last_attempt_completed_at: string | null;
          last_attempt_started_at: string | null;
          last_error_code: string | null;
          last_success_completed_at: string | null;
          last_success_started_at: string | null;
          overlap_start_at: string | null;
          pages_fetched: number;
          records_fetched: number;
          records_persisted: number;
          resource_type: string;
          run_id: string | null;
          state_version: number;
          status: string;
          updated_at: string;
        };
        Insert: {
          durable_total?: number | null;
          ebay_account_id: string;
          high_watermark_at?: string | null;
          id?: string;
          last_attempt_completed_at?: string | null;
          last_attempt_started_at?: string | null;
          last_error_code?: string | null;
          last_success_completed_at?: string | null;
          last_success_started_at?: string | null;
          overlap_start_at?: string | null;
          pages_fetched?: number;
          records_fetched?: number;
          records_persisted?: number;
          resource_type: string;
          run_id?: string | null;
          state_version?: number;
          status?: string;
          updated_at?: string;
        };
        Update: {
          durable_total?: number | null;
          ebay_account_id?: string;
          high_watermark_at?: string | null;
          id?: string;
          last_attempt_completed_at?: string | null;
          last_attempt_started_at?: string | null;
          last_error_code?: string | null;
          last_success_completed_at?: string | null;
          last_success_started_at?: string | null;
          overlap_start_at?: string | null;
          pages_fetched?: number;
          records_fetched?: number;
          records_persisted?: number;
          resource_type?: string;
          run_id?: string | null;
          state_version?: number;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ebay_sync_state_ebay_account_id_fkey";
            columns: ["ebay_account_id"];
            isOneToOne: false;
            referencedRelation: "ebay_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      image_derivatives: {
        Row: {
          created_at: string;
          derivative_type: string;
          height: number;
          id: string;
          owner_id: string | null;
          sha256: string;
          slab_image_id: string;
          storage_path: string;
          transform_manifest: Json;
          width: number;
        };
        Insert: {
          created_at?: string;
          derivative_type: string;
          height: number;
          id?: string;
          owner_id?: string | null;
          sha256: string;
          slab_image_id: string;
          storage_path: string;
          transform_manifest: Json;
          width: number;
        };
        Update: {
          created_at?: string;
          derivative_type?: string;
          height?: number;
          id?: string;
          owner_id?: string | null;
          sha256?: string;
          slab_image_id?: string;
          storage_path?: string;
          transform_manifest?: Json;
          width?: number;
        };
        Relationships: [
          {
            foreignKeyName: "image_derivatives_slab_image_id_fkey";
            columns: ["slab_image_id"];
            isOneToOne: false;
            referencedRelation: "slab_images";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_errors: {
        Row: {
          attempt_count: number;
          created_at: string;
          error_code: string | null;
          id: string;
          next_attempt_at: string | null;
          operation: string;
          provider: string;
          resolved_at: string | null;
          retryable: boolean;
          safe_message: string;
        };
        Insert: {
          attempt_count?: number;
          created_at?: string;
          error_code?: string | null;
          id?: string;
          next_attempt_at?: string | null;
          operation: string;
          provider: string;
          resolved_at?: string | null;
          retryable?: boolean;
          safe_message: string;
        };
        Update: {
          attempt_count?: number;
          created_at?: string;
          error_code?: string | null;
          id?: string;
          next_attempt_at?: string | null;
          operation?: string;
          provider?: string;
          resolved_at?: string | null;
          retryable?: boolean;
          safe_message?: string;
        };
        Relationships: [];
      };
      marketplace_events: {
        Row: {
          created_at: string;
          event_type: string;
          external_id: string | null;
          id: string;
          idempotency_key: string;
          processed_at: string | null;
          provider: string;
          safe_payload: Json;
          slab_id: string | null;
        };
        Insert: {
          created_at?: string;
          event_type: string;
          external_id?: string | null;
          id?: string;
          idempotency_key: string;
          processed_at?: string | null;
          provider: string;
          safe_payload?: Json;
          slab_id?: string | null;
        };
        Update: {
          created_at?: string;
          event_type?: string;
          external_id?: string | null;
          id?: string;
          idempotency_key?: string;
          processed_at?: string | null;
          provider?: string;
          safe_payload?: Json;
          slab_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "marketplace_events_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      pricecharting_marketplace_settings: {
        Row: {
          last_synced_at: string | null;
          seller_id: string | null;
          singleton: boolean;
          sync_enabled: boolean;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          last_synced_at?: string | null;
          seller_id?: string | null;
          singleton?: boolean;
          sync_enabled?: boolean;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          last_synced_at?: string | null;
          seller_id?: string | null;
          singleton?: boolean;
          sync_enabled?: boolean;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      pricecharting_offer_events: {
        Row: {
          actor_user_id: string | null;
          detail: Json;
          event_at: string;
          event_type: string;
          id: number;
          offer_id: string;
          slab_id: string;
        };
        Insert: {
          actor_user_id?: string | null;
          detail?: Json;
          event_at?: string;
          event_type: string;
          id?: never;
          offer_id: string;
          slab_id: string;
        };
        Update: {
          actor_user_id?: string | null;
          detail?: Json;
          event_at?: string;
          event_type?: string;
          id?: never;
          offer_id?: string;
          slab_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "pricecharting_offer_events_offer_id_fkey";
            columns: ["offer_id"];
            isOneToOne: false;
            referencedRelation: "pricecharting_offers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pricecharting_offer_events_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      pricecharting_offers: {
        Row: {
          condition_id: number | null;
          cost_basis_cents: number | null;
          created_at: string;
          created_by: string | null;
          ended_at: string | null;
          feedback_status: string | null;
          id: string;
          last_synced_at: string;
          listed_at: string | null;
          maximum_price_cents: number | null;
          minimum_price_cents: number | null;
          offer_id: string;
          offer_status: string;
          price_max_cents: number | null;
          price_min_cents: number | null;
          pricecharting_offer_id: string | null;
          pricecharting_product_id: string | null;
          product_id: string | null;
          product_name: string | null;
          raw_response: Json;
          refunded: boolean | null;
          refunded_at: string | null;
          sale_price_cents: number | null;
          shipped: boolean | null;
          shipped_at: string | null;
          shipping_premium_cents: number | null;
          sku: string | null;
          slab_id: string;
          sold_at: string | null;
          tracking_number: string | null;
          tracking_status: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          condition_id?: number | null;
          cost_basis_cents?: number | null;
          created_at?: string;
          created_by?: string | null;
          ended_at?: string | null;
          feedback_status?: string | null;
          id?: string;
          last_synced_at?: string;
          listed_at?: string | null;
          maximum_price_cents?: number | null;
          minimum_price_cents?: number | null;
          offer_id: string;
          offer_status?: string;
          price_max_cents?: number | null;
          price_min_cents?: number | null;
          pricecharting_offer_id?: string | null;
          pricecharting_product_id?: string | null;
          product_id?: string | null;
          product_name?: string | null;
          raw_response?: Json;
          refunded?: boolean | null;
          refunded_at?: string | null;
          sale_price_cents?: number | null;
          shipped?: boolean | null;
          shipped_at?: string | null;
          shipping_premium_cents?: number | null;
          sku?: string | null;
          slab_id: string;
          sold_at?: string | null;
          tracking_number?: string | null;
          tracking_status?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          condition_id?: number | null;
          cost_basis_cents?: number | null;
          created_at?: string;
          created_by?: string | null;
          ended_at?: string | null;
          feedback_status?: string | null;
          id?: string;
          last_synced_at?: string;
          listed_at?: string | null;
          maximum_price_cents?: number | null;
          minimum_price_cents?: number | null;
          offer_id?: string;
          offer_status?: string;
          price_max_cents?: number | null;
          price_min_cents?: number | null;
          pricecharting_offer_id?: string | null;
          pricecharting_product_id?: string | null;
          product_id?: string | null;
          product_name?: string | null;
          raw_response?: Json;
          refunded?: boolean | null;
          refunded_at?: string | null;
          sale_price_cents?: number | null;
          shipped?: boolean | null;
          shipped_at?: string | null;
          shipping_premium_cents?: number | null;
          sku?: string | null;
          slab_id?: string;
          sold_at?: string | null;
          tracking_number?: string | null;
          tracking_status?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "pricecharting_offers_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      pricecharting_products: {
        Row: {
          canonical_url: string | null;
          console_name: string | null;
          first_seen_at: string;
          last_refreshed_at: string;
          last_verified_at: string | null;
          product_id: string;
          product_name: string;
          provider_evidence_at: string | null;
          raw_response: Json;
          reference_image_source: string | null;
          reference_image_url: string | null;
          tier_snapshot: Json | null;
        };
        Insert: {
          canonical_url?: string | null;
          console_name?: string | null;
          first_seen_at?: string;
          last_refreshed_at?: string;
          last_verified_at?: string | null;
          product_id: string;
          product_name: string;
          provider_evidence_at?: string | null;
          raw_response: Json;
          reference_image_source?: string | null;
          reference_image_url?: string | null;
          tier_snapshot?: Json | null;
        };
        Update: {
          canonical_url?: string | null;
          console_name?: string | null;
          first_seen_at?: string;
          last_refreshed_at?: string;
          last_verified_at?: string | null;
          product_id?: string;
          product_name?: string;
          provider_evidence_at?: string | null;
          raw_response?: Json;
          reference_image_source?: string | null;
          reference_image_url?: string | null;
          tier_snapshot?: Json | null;
        };
        Relationships: [];
      };
      pricecharting_sync_runs: {
        Row: {
          comps_created: number;
          created_by: string | null;
          error_message: string | null;
          finished_at: string | null;
          id: string;
          offers_seen: number;
          offers_updated: number;
          started_at: string;
          status: string;
          trigger_kind: string;
        };
        Insert: {
          comps_created?: number;
          created_by?: string | null;
          error_message?: string | null;
          finished_at?: string | null;
          id?: string;
          offers_seen?: number;
          offers_updated?: number;
          started_at?: string;
          status?: string;
          trigger_kind?: string;
        };
        Update: {
          comps_created?: number;
          created_by?: string | null;
          error_message?: string | null;
          finished_at?: string | null;
          id?: string;
          offers_seen?: number;
          offers_updated?: number;
          started_at?: string;
          status?: string;
          trigger_kind?: string;
        };
        Relationships: [];
      };
      slab_admins: {
        Row: {
          created_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      slab_comps: {
        Row: {
          created_at: string;
          exact_match: boolean | null;
          grade: string | null;
          grader: string | null;
          id: string;
          marketplace: string | null;
          notes: string | null;
          owner_id: string | null;
          sale_date: string | null;
          shipping_cents: number | null;
          slab_id: string;
          sold_price_cents: number | null;
          source_kind: string | null;
          source_offer_id: string | null;
          source_url: string | null;
          total_price_cents: number | null;
        };
        Insert: {
          created_at?: string;
          exact_match?: boolean | null;
          grade?: string | null;
          grader?: string | null;
          id?: string;
          marketplace?: string | null;
          notes?: string | null;
          owner_id?: string | null;
          sale_date?: string | null;
          shipping_cents?: number | null;
          slab_id: string;
          sold_price_cents?: number | null;
          source_kind?: string | null;
          source_offer_id?: string | null;
          source_url?: string | null;
          total_price_cents?: number | null;
        };
        Update: {
          created_at?: string;
          exact_match?: boolean | null;
          grade?: string | null;
          grader?: string | null;
          id?: string;
          marketplace?: string | null;
          notes?: string | null;
          owner_id?: string | null;
          sale_date?: string | null;
          shipping_cents?: number | null;
          slab_id?: string;
          sold_price_cents?: number | null;
          source_kind?: string | null;
          source_offer_id?: string | null;
          source_url?: string | null;
          total_price_cents?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "slab_comps_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      slab_images: {
        Row: {
          created_at: string;
          created_by: string | null;
          height: number | null;
          id: string;
          image_role: string;
          is_original: boolean;
          mime_type: string;
          owner_id: string | null;
          sha256: string;
          slab_id: string;
          storage_path: string;
          width: number | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          height?: number | null;
          id?: string;
          image_role: string;
          is_original?: boolean;
          mime_type: string;
          owner_id?: string | null;
          sha256: string;
          slab_id: string;
          storage_path: string;
          width?: number | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          height?: number | null;
          id?: string;
          image_role?: string;
          is_original?: boolean;
          mime_type?: string;
          owner_id?: string | null;
          sha256?: string;
          slab_id?: string;
          storage_path?: string;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "slab_images_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      slab_pricecharting_events: {
        Row: {
          created_at: string;
          created_by: string | null;
          detail: Json | null;
          event_type: string;
          id: string;
          owner_id: string | null;
          product_id: string | null;
          slab_id: string;
          source: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          detail?: Json | null;
          event_type: string;
          id?: string;
          owner_id?: string | null;
          product_id?: string | null;
          slab_id: string;
          source?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          detail?: Json | null;
          event_type?: string;
          id?: string;
          owner_id?: string | null;
          product_id?: string | null;
          slab_id?: string;
          source?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "slab_pricecharting_events_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      slab_product_candidates: {
        Row: {
          artwork_agreement: Json | null;
          candidate_rank: number;
          created_at: string;
          gate_status: string;
          id: string;
          metadata_agreement: Json;
          owner_id: string | null;
          pricecharting_product_id: string;
          rejection_reasons: Json;
          score: number;
          slab_id: string;
        };
        Insert: {
          artwork_agreement?: Json | null;
          candidate_rank: number;
          created_at?: string;
          gate_status: string;
          id?: string;
          metadata_agreement?: Json;
          owner_id?: string | null;
          pricecharting_product_id: string;
          rejection_reasons?: Json;
          score: number;
          slab_id: string;
        };
        Update: {
          artwork_agreement?: Json | null;
          candidate_rank?: number;
          created_at?: string;
          gate_status?: string;
          id?: string;
          metadata_agreement?: Json;
          owner_id?: string | null;
          pricecharting_product_id?: string;
          rejection_reasons?: Json;
          score?: number;
          slab_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "slab_product_candidates_pricecharting_product_id_fkey";
            columns: ["pricecharting_product_id"];
            isOneToOne: false;
            referencedRelation: "pricecharting_products";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "slab_product_candidates_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      slab_product_links: {
        Row: {
          confirmed_at: string | null;
          confirmed_by: string | null;
          created_at: string;
          id: string;
          link_method: string;
          link_status: string;
          override_reason: string | null;
          owner_id: string | null;
          pricecharting_product_id: string;
          slab_id: string;
        };
        Insert: {
          confirmed_at?: string | null;
          confirmed_by?: string | null;
          created_at?: string;
          id?: string;
          link_method: string;
          link_status: string;
          override_reason?: string | null;
          owner_id?: string | null;
          pricecharting_product_id: string;
          slab_id: string;
        };
        Update: {
          confirmed_at?: string | null;
          confirmed_by?: string | null;
          created_at?: string;
          id?: string;
          link_method?: string;
          link_status?: string;
          override_reason?: string | null;
          owner_id?: string | null;
          pricecharting_product_id?: string;
          slab_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "slab_product_links_pricecharting_product_id_fkey";
            columns: ["pricecharting_product_id"];
            isOneToOne: false;
            referencedRelation: "pricecharting_products";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "slab_product_links_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      slab_settings: {
        Row: {
          allow_hard_delete: boolean;
          id: boolean;
          updated_at: string;
        };
        Insert: {
          allow_hard_delete?: boolean;
          id?: boolean;
          updated_at?: string;
        };
        Update: {
          allow_hard_delete?: boolean;
          id?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      slabs: {
        Row: {
          acquired_at: string | null;
          archived_at: string | null;
          back_image_path: string | null;
          candidate_image_available: boolean | null;
          candidate_image_retrieved_at: string | null;
          candidate_image_source: string | null;
          candidate_image_type: string | null;
          candidate_image_url: string | null;
          card_name: string | null;
          card_number: string | null;
          certification_number: string | null;
          certification_number_normalized: string | null;
          certification_verification_status: string;
          cgc_population_card_id: string | null;
          cgc_population_match_confidence: number | null;
          cgc_population_match_method: string | null;
          cgc_population_match_status: string | null;
          cgc_population_matched_at: string | null;
          cgc_population_snapshot: Json | null;
          cost_basis_cents: number | null;
          created_at: string;
          date_valued: string | null;
          duplicate_status: string | null;
          final_value_cents: number | null;
          finish: string | null;
          front_image_path: string | null;
          game_or_franchise: string | null;
          grade: string | null;
          grade_label: string | null;
          grader: string | null;
          grader_normalized: string | null;
          id: string;
          inventory_code: string | null;
          inventory_number: number;
          inventory_prefix: string;
          inventory_sequence: number;
          inventory_status: string;
          label_accuracy: string | null;
          label_description: string | null;
          language: string | null;
          notes: string | null;
          owner_id: string;
          price_variance_percent: number | null;
          pricecharting_grade_field: string | null;
          pricecharting_match_status: string | null;
          pricecharting_priced_at: string | null;
          pricecharting_product_id: string | null;
          pricecharting_product_name: string | null;
          pricecharting_raw: Json | null;
          pricecharting_sales_volume: number | null;
          pricecharting_tiers: Json | null;
          pricecharting_value_cents: number | null;
          product_confirmation_source: string | null;
          product_confirmed_at: string | null;
          quick_sale_value_cents: number | null;
          rarity: string | null;
          replacement_value_cents: number | null;
          sale_shipping_cents: number | null;
          scoring_version: number | null;
          set_name: string | null;
          sold_at: string | null;
          sold_price_cents: number | null;
          updated_at: string;
          valuation_confidence: string | null;
          valuation_provenance: string;
          valuation_status: string;
          variation: string | null;
          verification_status: string;
          visual_confirmation_at: string | null;
          visual_confirmation_by: string | null;
          visual_confirmation_method: string | null;
          visual_confirmation_status: string | null;
          visual_identity_status: string;
          visual_rejection_note: string | null;
          visual_rejection_reason: string | null;
          year: number | null;
        };
        Insert: {
          acquired_at?: string | null;
          archived_at?: string | null;
          back_image_path?: string | null;
          candidate_image_available?: boolean | null;
          candidate_image_retrieved_at?: string | null;
          candidate_image_source?: string | null;
          candidate_image_type?: string | null;
          candidate_image_url?: string | null;
          card_name?: string | null;
          card_number?: string | null;
          certification_number?: string | null;
          certification_number_normalized?: string | null;
          certification_verification_status?: string;
          cgc_population_card_id?: string | null;
          cgc_population_match_confidence?: number | null;
          cgc_population_match_method?: string | null;
          cgc_population_match_status?: string | null;
          cgc_population_matched_at?: string | null;
          cgc_population_snapshot?: Json | null;
          cost_basis_cents?: number | null;
          created_at?: string;
          date_valued?: string | null;
          duplicate_status?: string | null;
          final_value_cents?: number | null;
          finish?: string | null;
          front_image_path?: string | null;
          game_or_franchise?: string | null;
          grade?: string | null;
          grade_label?: string | null;
          grader?: string | null;
          grader_normalized?: string | null;
          id?: string;
          inventory_code?: string | null;
          inventory_number: number;
          inventory_prefix?: string;
          inventory_sequence: number;
          inventory_status?: string;
          label_accuracy?: string | null;
          label_description?: string | null;
          language?: string | null;
          notes?: string | null;
          owner_id: string;
          price_variance_percent?: number | null;
          pricecharting_grade_field?: string | null;
          pricecharting_match_status?: string | null;
          pricecharting_priced_at?: string | null;
          pricecharting_product_id?: string | null;
          pricecharting_product_name?: string | null;
          pricecharting_raw?: Json | null;
          pricecharting_sales_volume?: number | null;
          pricecharting_tiers?: Json | null;
          pricecharting_value_cents?: number | null;
          product_confirmation_source?: string | null;
          product_confirmed_at?: string | null;
          quick_sale_value_cents?: number | null;
          rarity?: string | null;
          replacement_value_cents?: number | null;
          sale_shipping_cents?: number | null;
          scoring_version?: number | null;
          set_name?: string | null;
          sold_at?: string | null;
          sold_price_cents?: number | null;
          updated_at?: string;
          valuation_confidence?: string | null;
          valuation_provenance: string;
          valuation_status?: string;
          variation?: string | null;
          verification_status: string;
          visual_confirmation_at?: string | null;
          visual_confirmation_by?: string | null;
          visual_confirmation_method?: string | null;
          visual_confirmation_status?: string | null;
          visual_identity_status?: string;
          visual_rejection_note?: string | null;
          visual_rejection_reason?: string | null;
          year?: number | null;
        };
        Update: {
          acquired_at?: string | null;
          archived_at?: string | null;
          back_image_path?: string | null;
          candidate_image_available?: boolean | null;
          candidate_image_retrieved_at?: string | null;
          candidate_image_source?: string | null;
          candidate_image_type?: string | null;
          candidate_image_url?: string | null;
          card_name?: string | null;
          card_number?: string | null;
          certification_number?: string | null;
          certification_number_normalized?: string | null;
          certification_verification_status?: string;
          cgc_population_card_id?: string | null;
          cgc_population_match_confidence?: number | null;
          cgc_population_match_method?: string | null;
          cgc_population_match_status?: string | null;
          cgc_population_matched_at?: string | null;
          cgc_population_snapshot?: Json | null;
          cost_basis_cents?: number | null;
          created_at?: string;
          date_valued?: string | null;
          duplicate_status?: string | null;
          final_value_cents?: number | null;
          finish?: string | null;
          front_image_path?: string | null;
          game_or_franchise?: string | null;
          grade?: string | null;
          grade_label?: string | null;
          grader?: string | null;
          grader_normalized?: string | null;
          id?: string;
          inventory_code?: string | null;
          inventory_number?: number;
          inventory_prefix?: string;
          inventory_sequence?: number;
          inventory_status?: string;
          label_accuracy?: string | null;
          label_description?: string | null;
          language?: string | null;
          notes?: string | null;
          owner_id?: string;
          price_variance_percent?: number | null;
          pricecharting_grade_field?: string | null;
          pricecharting_match_status?: string | null;
          pricecharting_priced_at?: string | null;
          pricecharting_product_id?: string | null;
          pricecharting_product_name?: string | null;
          pricecharting_raw?: Json | null;
          pricecharting_sales_volume?: number | null;
          pricecharting_tiers?: Json | null;
          pricecharting_value_cents?: number | null;
          product_confirmation_source?: string | null;
          product_confirmed_at?: string | null;
          quick_sale_value_cents?: number | null;
          rarity?: string | null;
          replacement_value_cents?: number | null;
          sale_shipping_cents?: number | null;
          scoring_version?: number | null;
          set_name?: string | null;
          sold_at?: string | null;
          sold_price_cents?: number | null;
          updated_at?: string;
          valuation_confidence?: string | null;
          valuation_provenance?: string;
          valuation_status?: string;
          variation?: string | null;
          verification_status?: string;
          visual_confirmation_at?: string | null;
          visual_confirmation_by?: string | null;
          visual_confirmation_method?: string | null;
          visual_confirmation_status?: string | null;
          visual_identity_status?: string;
          visual_rejection_note?: string | null;
          visual_rejection_reason?: string | null;
          year?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "slabs_cgc_population_card_id_fkey";
            columns: ["cgc_population_card_id"];
            isOneToOne: false;
            referencedRelation: "cgc_population_cards";
            referencedColumns: ["id"];
          },
        ];
      };
      sold_comps: {
        Row: {
          created_at: string;
          currency: string;
          external_sale_id: string;
          fees_cents: number | null;
          id: string;
          owner_id: string | null;
          pricecharting_product_id: string | null;
          raw_response: Json | null;
          shipping_cents: number | null;
          slab_id: string | null;
          sold_at: string;
          sold_price_cents: number;
          source: string;
        };
        Insert: {
          created_at?: string;
          currency?: string;
          external_sale_id: string;
          fees_cents?: number | null;
          id?: string;
          owner_id?: string | null;
          pricecharting_product_id?: string | null;
          raw_response?: Json | null;
          shipping_cents?: number | null;
          slab_id?: string | null;
          sold_at: string;
          sold_price_cents: number;
          source: string;
        };
        Update: {
          created_at?: string;
          currency?: string;
          external_sale_id?: string;
          fees_cents?: number | null;
          id?: string;
          owner_id?: string | null;
          pricecharting_product_id?: string | null;
          raw_response?: Json | null;
          shipping_cents?: number | null;
          slab_id?: string | null;
          sold_at?: string;
          sold_price_cents?: number;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sold_comps_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      valuation_snapshots: {
        Row: {
          confidence: string;
          currency: string;
          guide_value_cents: number | null;
          id: string;
          owner_id: string | null;
          pricecharting_product_id: string | null;
          quick_sale_value_cents: number | null;
          raw_response: Json | null;
          replacement_value_cents: number | null;
          slab_id: string;
          source: string;
          source_field: string | null;
          tier_relationship: string;
          valued_at: string;
        };
        Insert: {
          confidence: string;
          currency?: string;
          guide_value_cents?: number | null;
          id?: string;
          owner_id?: string | null;
          pricecharting_product_id?: string | null;
          quick_sale_value_cents?: number | null;
          raw_response?: Json | null;
          replacement_value_cents?: number | null;
          slab_id: string;
          source?: string;
          source_field?: string | null;
          tier_relationship: string;
          valued_at?: string;
        };
        Update: {
          confidence?: string;
          currency?: string;
          guide_value_cents?: number | null;
          id?: string;
          owner_id?: string | null;
          pricecharting_product_id?: string | null;
          quick_sale_value_cents?: number | null;
          raw_response?: Json | null;
          replacement_value_cents?: number | null;
          slab_id?: string;
          source?: string;
          source_field?: string | null;
          tier_relationship?: string;
          valued_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "valuation_snapshots_pricecharting_product_id_fkey";
            columns: ["pricecharting_product_id"];
            isOneToOne: false;
            referencedRelation: "pricecharting_products";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "valuation_snapshots_slab_id_fkey";
            columns: ["slab_id"];
            isOneToOne: false;
            referencedRelation: "slabs";
            referencedColumns: ["id"];
          },
        ];
      };
      webhook_inbox: {
        Row: {
          attempt_count: number;
          created_at: string;
          event_type: string | null;
          id: string;
          idempotency_key: string;
          next_attempt_at: string | null;
          payload_sha256: string;
          processed_at: string | null;
          provider: string;
          safe_headers: Json;
          signature_valid: boolean;
          status: string;
        };
        Insert: {
          attempt_count?: number;
          created_at?: string;
          event_type?: string | null;
          id?: string;
          idempotency_key: string;
          next_attempt_at?: string | null;
          payload_sha256: string;
          processed_at?: string | null;
          provider: string;
          safe_headers?: Json;
          signature_valid?: boolean;
          status?: string;
        };
        Update: {
          attempt_count?: number;
          created_at?: string;
          event_type?: string | null;
          id?: string;
          idempotency_key?: string;
          next_attempt_at?: string | null;
          payload_sha256?: string;
          processed_at?: string | null;
          provider?: string;
          safe_headers?: Json;
          signature_valid?: boolean;
          status?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      acknowledge_slab_storage_cleanup: {
        Args: { p_paths: string[] };
        Returns: number;
      };
      apply_pricecharting_offer_snapshot: {
        Args: { p_event_type?: string; p_slab_id: string; p_snapshot: Json };
        Returns: {
          condition_id: number | null;
          cost_basis_cents: number | null;
          created_at: string;
          created_by: string | null;
          ended_at: string | null;
          feedback_status: string | null;
          id: string;
          last_synced_at: string;
          listed_at: string | null;
          maximum_price_cents: number | null;
          minimum_price_cents: number | null;
          offer_id: string;
          offer_status: string;
          price_max_cents: number | null;
          price_min_cents: number | null;
          pricecharting_offer_id: string | null;
          pricecharting_product_id: string | null;
          product_id: string | null;
          product_name: string | null;
          raw_response: Json;
          refunded: boolean | null;
          refunded_at: string | null;
          sale_price_cents: number | null;
          shipped: boolean | null;
          shipped_at: string | null;
          shipping_premium_cents: number | null;
          sku: string | null;
          slab_id: string;
          sold_at: string | null;
          tracking_number: string | null;
          tracking_status: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "pricecharting_offers";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      apply_slab_pricing: {
        Args: {
          p_priced_at: string;
          p_raw: Json;
          p_scalars?: Json;
          p_slab_id: string;
          p_tiers: Json;
        };
        Returns: boolean;
      };
      archive_slab: {
        Args: { p_id: string };
        Returns: {
          acquired_at: string | null;
          archived_at: string | null;
          back_image_path: string | null;
          candidate_image_available: boolean | null;
          candidate_image_retrieved_at: string | null;
          candidate_image_source: string | null;
          candidate_image_type: string | null;
          candidate_image_url: string | null;
          card_name: string | null;
          card_number: string | null;
          certification_number: string | null;
          certification_number_normalized: string | null;
          certification_verification_status: string;
          cgc_population_card_id: string | null;
          cgc_population_match_confidence: number | null;
          cgc_population_match_method: string | null;
          cgc_population_match_status: string | null;
          cgc_population_matched_at: string | null;
          cgc_population_snapshot: Json | null;
          cost_basis_cents: number | null;
          created_at: string;
          date_valued: string | null;
          duplicate_status: string | null;
          final_value_cents: number | null;
          finish: string | null;
          front_image_path: string | null;
          game_or_franchise: string | null;
          grade: string | null;
          grade_label: string | null;
          grader: string | null;
          grader_normalized: string | null;
          id: string;
          inventory_code: string | null;
          inventory_number: number;
          inventory_prefix: string;
          inventory_sequence: number;
          inventory_status: string;
          label_accuracy: string | null;
          label_description: string | null;
          language: string | null;
          notes: string | null;
          owner_id: string;
          price_variance_percent: number | null;
          pricecharting_grade_field: string | null;
          pricecharting_match_status: string | null;
          pricecharting_priced_at: string | null;
          pricecharting_product_id: string | null;
          pricecharting_product_name: string | null;
          pricecharting_raw: Json | null;
          pricecharting_sales_volume: number | null;
          pricecharting_tiers: Json | null;
          pricecharting_value_cents: number | null;
          product_confirmation_source: string | null;
          product_confirmed_at: string | null;
          quick_sale_value_cents: number | null;
          rarity: string | null;
          replacement_value_cents: number | null;
          sale_shipping_cents: number | null;
          scoring_version: number | null;
          set_name: string | null;
          sold_at: string | null;
          sold_price_cents: number | null;
          updated_at: string;
          valuation_confidence: string | null;
          valuation_provenance: string;
          valuation_status: string;
          variation: string | null;
          verification_status: string;
          visual_confirmation_at: string | null;
          visual_confirmation_by: string | null;
          visual_confirmation_method: string | null;
          visual_confirmation_status: string | null;
          visual_identity_status: string;
          visual_rejection_note: string | null;
          visual_rejection_reason: string | null;
          year: number | null;
        };
        SetofOptions: {
          from: "*";
          to: "slabs";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      builder_append_audit_event: {
        Args: {
          p_actor: string;
          p_correlation_id: string;
          p_detail: Json;
          p_event_type: string;
          p_run_id: string;
        };
        Returns: string;
      };
      can_access_slab: { Args: { p_slab_id: string }; Returns: boolean };
      cgc_claim_import_run: {
        Args: {
          p_input: Json;
          p_min_hours?: number;
          p_mode: string;
          p_requested_by: string;
          p_set_id: string;
        };
        Returns: {
          apify_run_id: string | null;
          completed_at: string | null;
          created_at: string;
          dataset_id: string | null;
          error: string | null;
          id: string;
          input: Json | null;
          item_count: number | null;
          mode: string | null;
          requested_by: string | null;
          set_id: string | null;
          started_at: string | null;
          status: string;
        };
        SetofOptions: {
          from: "*";
          to: "cgc_population_import_runs";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      check_slab_certification: {
        Args: { p_cert: string; p_grader: string };
        Returns: {
          id: string;
          inventory_number: number;
        }[];
      };
      compact_slab_inventory_ids: { Args: never; Returns: number };
      consume_daily_quota: {
        Args: { p_bucket: string; p_limit: number };
        Returns: boolean;
      };
      consume_user_daily_quota: {
        Args: { p_bucket: string; p_hard_limit: number; p_user_id: string };
        Returns: boolean;
      };
      create_slab: {
        Args: { p: Json; p_back_ext: string; p_front_ext: string };
        Returns: {
          acquired_at: string | null;
          archived_at: string | null;
          back_image_path: string | null;
          candidate_image_available: boolean | null;
          candidate_image_retrieved_at: string | null;
          candidate_image_source: string | null;
          candidate_image_type: string | null;
          candidate_image_url: string | null;
          card_name: string | null;
          card_number: string | null;
          certification_number: string | null;
          certification_number_normalized: string | null;
          certification_verification_status: string;
          cgc_population_card_id: string | null;
          cgc_population_match_confidence: number | null;
          cgc_population_match_method: string | null;
          cgc_population_match_status: string | null;
          cgc_population_matched_at: string | null;
          cgc_population_snapshot: Json | null;
          cost_basis_cents: number | null;
          created_at: string;
          date_valued: string | null;
          duplicate_status: string | null;
          final_value_cents: number | null;
          finish: string | null;
          front_image_path: string | null;
          game_or_franchise: string | null;
          grade: string | null;
          grade_label: string | null;
          grader: string | null;
          grader_normalized: string | null;
          id: string;
          inventory_code: string | null;
          inventory_number: number;
          inventory_prefix: string;
          inventory_sequence: number;
          inventory_status: string;
          label_accuracy: string | null;
          label_description: string | null;
          language: string | null;
          notes: string | null;
          owner_id: string;
          price_variance_percent: number | null;
          pricecharting_grade_field: string | null;
          pricecharting_match_status: string | null;
          pricecharting_priced_at: string | null;
          pricecharting_product_id: string | null;
          pricecharting_product_name: string | null;
          pricecharting_raw: Json | null;
          pricecharting_sales_volume: number | null;
          pricecharting_tiers: Json | null;
          pricecharting_value_cents: number | null;
          product_confirmation_source: string | null;
          product_confirmed_at: string | null;
          quick_sale_value_cents: number | null;
          rarity: string | null;
          replacement_value_cents: number | null;
          sale_shipping_cents: number | null;
          scoring_version: number | null;
          set_name: string | null;
          sold_at: string | null;
          sold_price_cents: number | null;
          updated_at: string;
          valuation_confidence: string | null;
          valuation_provenance: string;
          valuation_status: string;
          variation: string | null;
          verification_status: string;
          visual_confirmation_at: string | null;
          visual_confirmation_by: string | null;
          visual_confirmation_method: string | null;
          visual_confirmation_status: string | null;
          visual_identity_status: string;
          visual_rejection_note: string | null;
          visual_rejection_reason: string | null;
          year: number | null;
        };
        SetofOptions: {
          from: "*";
          to: "slabs";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      ebay_api_run_record: {
        Args: {
          p_account_id: string;
          p_error_code: string;
          p_http_status: number;
          p_latency_ms: number;
          p_operation: string;
          p_request_id: string;
          p_status: string;
        };
        Returns: undefined;
      };
      ebay_business_policies_replace: {
        Args: { p_account_id: string; p_policies: Json };
        Returns: Json;
      };
      ebay_credential_scopes_get: {
        Args: { p_account_id: string };
        Returns: {
          requested_scopes: string[];
          scope_source: string;
          token_reported_scopes: string[];
        }[];
      };
      ebay_credential_scopes_set: {
        Args: {
          p_account_id: string;
          p_requested_scopes: string[];
          p_scope_source: string;
          p_token_reported_scopes: string[];
        };
        Returns: undefined;
      };
      ebay_finance_transactions_apply: {
        Args: { p_account_id: string; p_transactions: Json };
        Returns: Json;
      };
      ebay_inventory_locations_replace: {
        Args: { p_account_id: string; p_locations: Json };
        Returns: number;
      };
      ebay_listing_reconcile_local: {
        Args: {
          p_account_id: string;
          p_asking_price_cents: number;
          p_currency: string;
          p_expected_fingerprint: string;
          p_expected_fingerprint_version: number;
          p_expected_listing_id: string;
          p_expected_offer_id: string;
          p_expected_status: string;
          p_expected_updated_at: string;
          p_intent_id: string;
          p_listing_id: string;
          p_listing_status: string;
          p_offer_id: string;
          p_sku: string;
          p_slab_id: string;
        };
        Returns: Json;
      };
      ebay_oauth_credential_get: {
        Args: { p_account_id: string };
        Returns: {
          refresh_token_encrypted: string;
          requested_scopes: string[];
          scope_source: string;
          scopes: string[];
          token_reported_scopes: string[];
        }[];
      };
      ebay_oauth_credential_rotate: {
        Args: {
          p_account_id: string;
          p_new_encrypted: string;
          p_prior_encrypted: string;
          p_refresh_token_expires_at: string;
          p_rotated_at: string;
          p_scopes: string[];
        };
        Returns: number;
      };
      ebay_oauth_credential_upsert: {
        Args: {
          p_account_id: string;
          p_refresh_token_encrypted: string;
          p_refresh_token_expires_at: string;
          p_rotated_at: string;
          p_scopes: string[];
        };
        Returns: undefined;
      };
      ebay_oauth_state_consume: {
        Args: { p_state_hash: string };
        Returns: undefined;
      };
      ebay_oauth_state_create: {
        Args: {
          p_expires_at: string;
          p_redirect_after: string;
          p_requested_by: string;
          p_state_hash: string;
        };
        Returns: undefined;
      };
      ebay_oauth_state_create_single_flight: {
        Args: {
          p_expires_at: string;
          p_redirect_after: string;
          p_requested_by: string;
          p_state_hash: string;
        };
        Returns: undefined;
      };
      ebay_oauth_state_get: {
        Args: { p_state_hash: string };
        Returns: {
          consumed_at: string;
          expires_at: string;
          redirect_after: string;
          requested_by: string;
        }[];
      };
      ebay_orders_persist: {
        Args: { p_account_id: string; p_orders: Json };
        Returns: Json;
      };
      ebay_publish_lease_acquire: {
        Args: {
          p_account_id: string;
          p_sku: string;
          p_token: string;
          p_ttl_seconds: number;
        };
        Returns: Json;
      };
      ebay_publish_lease_assert_and_extend: {
        Args: {
          p_account_id: string;
          p_sku: string;
          p_token: string;
          p_ttl_seconds: number;
        };
        Returns: Json;
      };
      ebay_publish_lease_release: {
        Args: { p_account_id: string; p_sku: string; p_token: string };
        Returns: Json;
      };
      ebay_sales_apply: {
        Args: { p_account_id: string; p_sales: Json };
        Returns: Json;
      };
      ebay_sync_complete: {
        Args: {
          p_account_id: string;
          p_durable_total: number;
          p_high_watermark_at: string;
          p_latency_ms: number;
          p_lease_token: string;
          p_overlap_start_at: string;
          p_pages: number;
          p_records_fetched: number;
          p_records_persisted: number;
          p_resource_type: string;
          p_run_id: string;
        };
        Returns: Json;
      };
      ebay_sync_cursor_touch: {
        Args: {
          p_account_id: string;
          p_count: number;
          p_resource_type: string;
        };
        Returns: undefined;
      };
      ebay_sync_lease_acquire: {
        Args: {
          p_account_id: string;
          p_resource_type: string;
          p_token: string;
          p_ttl_seconds: number;
        };
        Returns: Json;
      };
      ebay_sync_lease_assert_and_extend: {
        Args: {
          p_account_id: string;
          p_resource_type: string;
          p_token: string;
          p_ttl_seconds: number;
        };
        Returns: Json;
      };
      ebay_sync_lease_release: {
        Args: {
          p_account_id: string;
          p_resource_type: string;
          p_token: string;
        };
        Returns: Json;
      };
      ebay_sync_state_fail: {
        Args: {
          p_account_id: string;
          p_error_code: string;
          p_resource_type: string;
          p_run_id: string;
        };
        Returns: Json;
      };
      ebay_sync_state_load: {
        Args: {
          p_account_id: string;
          p_lease_token: string;
          p_resource_type: string;
        };
        Returns: Json;
      };
      get_slab_deletion_tombstone: {
        Args: { p_slab_id: string };
        Returns: {
          card_name: string;
          certification_number: string;
          deleted_at: string;
          deleted_by: string;
          grade: string;
          grader: string;
          inventory_code: string;
          inventory_number: number;
          owner_id: string;
          reason: string;
          slab_id: string;
        }[];
      };
      hard_delete_slab: {
        Args: { p_id: string };
        Returns: {
          back_image_path: string;
          front_image_path: string;
        }[];
      };
      is_admin: { Args: { _user_id: string }; Returns: boolean };
      link_ai_analysis_run: {
        Args: { p_run_id: string; p_slab_id: string };
        Returns: undefined;
      };
      list_pending_slab_storage_cleanup: {
        Args: never;
        Returns: {
          storage_path: string;
        }[];
      };
      normalize_cert: { Args: { p: string }; Returns: string };
      normalize_grader: { Args: { p: string }; Returns: string };
      parse_inventory_code: {
        Args: { p_query: string };
        Returns: {
          prefix: string;
          sequence: number;
        }[];
      };
      pricecharting_game_url: {
        Args: { p_console: string; p_name: string };
        Returns: string;
      };
      purge_slabs: {
        Args: { p_ids: string[] };
        Returns: {
          back_image_path: string;
          front_image_path: string;
          slab_id: string;
        }[];
      };
      reassign_slab_inventory_id: {
        Args: { p_sequence: number; p_slab_id: string };
        Returns: {
          acquired_at: string | null;
          archived_at: string | null;
          back_image_path: string | null;
          candidate_image_available: boolean | null;
          candidate_image_retrieved_at: string | null;
          candidate_image_source: string | null;
          candidate_image_type: string | null;
          candidate_image_url: string | null;
          card_name: string | null;
          card_number: string | null;
          certification_number: string | null;
          certification_number_normalized: string | null;
          certification_verification_status: string;
          cgc_population_card_id: string | null;
          cgc_population_match_confidence: number | null;
          cgc_population_match_method: string | null;
          cgc_population_match_status: string | null;
          cgc_population_matched_at: string | null;
          cgc_population_snapshot: Json | null;
          cost_basis_cents: number | null;
          created_at: string;
          date_valued: string | null;
          duplicate_status: string | null;
          final_value_cents: number | null;
          finish: string | null;
          front_image_path: string | null;
          game_or_franchise: string | null;
          grade: string | null;
          grade_label: string | null;
          grader: string | null;
          grader_normalized: string | null;
          id: string;
          inventory_code: string | null;
          inventory_number: number;
          inventory_prefix: string;
          inventory_sequence: number;
          inventory_status: string;
          label_accuracy: string | null;
          label_description: string | null;
          language: string | null;
          notes: string | null;
          owner_id: string;
          price_variance_percent: number | null;
          pricecharting_grade_field: string | null;
          pricecharting_match_status: string | null;
          pricecharting_priced_at: string | null;
          pricecharting_product_id: string | null;
          pricecharting_product_name: string | null;
          pricecharting_raw: Json | null;
          pricecharting_sales_volume: number | null;
          pricecharting_tiers: Json | null;
          pricecharting_value_cents: number | null;
          product_confirmation_source: string | null;
          product_confirmed_at: string | null;
          quick_sale_value_cents: number | null;
          rarity: string | null;
          replacement_value_cents: number | null;
          sale_shipping_cents: number | null;
          scoring_version: number | null;
          set_name: string | null;
          sold_at: string | null;
          sold_price_cents: number | null;
          updated_at: string;
          valuation_confidence: string | null;
          valuation_provenance: string;
          valuation_status: string;
          variation: string | null;
          verification_status: string;
          visual_confirmation_at: string | null;
          visual_confirmation_by: string | null;
          visual_confirmation_method: string | null;
          visual_confirmation_status: string | null;
          visual_identity_status: string;
          visual_rejection_note: string | null;
          visual_rejection_reason: string | null;
          year: number | null;
        };
        SetofOptions: {
          from: "*";
          to: "slabs";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      reconcile_stale_exact_api_tier: { Args: never; Returns: number };
      record_pricecharting_confirmation: {
        Args: { p_event: Json; p_patch: Json; p_slab_id: string };
        Returns: undefined;
      };
      record_slab_storage_cleanup_failure: {
        Args: { p_error: string; p_paths: string[] };
        Returns: number;
      };
      reserve_api_request_slot: {
        Args: { p_bucket: string; p_min_interval_ms?: number };
        Returns: string;
      };
      resolve_inventory: {
        Args: { p_query: string };
        Returns: {
          id: string;
          inventory_code: string;
          inventory_sequence: number;
          item_type: string;
        }[];
      };
      resolve_slab_inventory: {
        Args: { p_query: string };
        Returns: {
          acquired_at: string | null;
          archived_at: string | null;
          back_image_path: string | null;
          candidate_image_available: boolean | null;
          candidate_image_retrieved_at: string | null;
          candidate_image_source: string | null;
          candidate_image_type: string | null;
          candidate_image_url: string | null;
          card_name: string | null;
          card_number: string | null;
          certification_number: string | null;
          certification_number_normalized: string | null;
          certification_verification_status: string;
          cgc_population_card_id: string | null;
          cgc_population_match_confidence: number | null;
          cgc_population_match_method: string | null;
          cgc_population_match_status: string | null;
          cgc_population_matched_at: string | null;
          cgc_population_snapshot: Json | null;
          cost_basis_cents: number | null;
          created_at: string;
          date_valued: string | null;
          duplicate_status: string | null;
          final_value_cents: number | null;
          finish: string | null;
          front_image_path: string | null;
          game_or_franchise: string | null;
          grade: string | null;
          grade_label: string | null;
          grader: string | null;
          grader_normalized: string | null;
          id: string;
          inventory_code: string | null;
          inventory_number: number;
          inventory_prefix: string;
          inventory_sequence: number;
          inventory_status: string;
          label_accuracy: string | null;
          label_description: string | null;
          language: string | null;
          notes: string | null;
          owner_id: string;
          price_variance_percent: number | null;
          pricecharting_grade_field: string | null;
          pricecharting_match_status: string | null;
          pricecharting_priced_at: string | null;
          pricecharting_product_id: string | null;
          pricecharting_product_name: string | null;
          pricecharting_raw: Json | null;
          pricecharting_sales_volume: number | null;
          pricecharting_tiers: Json | null;
          pricecharting_value_cents: number | null;
          product_confirmation_source: string | null;
          product_confirmed_at: string | null;
          quick_sale_value_cents: number | null;
          rarity: string | null;
          replacement_value_cents: number | null;
          sale_shipping_cents: number | null;
          scoring_version: number | null;
          set_name: string | null;
          sold_at: string | null;
          sold_price_cents: number | null;
          updated_at: string;
          valuation_confidence: string | null;
          valuation_provenance: string;
          valuation_status: string;
          variation: string | null;
          verification_status: string;
          visual_confirmation_at: string | null;
          visual_confirmation_by: string | null;
          visual_confirmation_method: string | null;
          visual_confirmation_status: string | null;
          visual_identity_status: string;
          visual_rejection_note: string | null;
          visual_rejection_reason: string | null;
          year: number | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "slabs";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      slab_object_owner: { Args: { p_name: string }; Returns: string };
      slab_owner: { Args: { p_slab_id: string }; Returns: string };
      stage_raw_card: {
        Args: { p: Json };
        Returns: {
          back_image_path: string | null;
          card_name: string;
          card_name_normalized: string | null;
          card_number: string;
          card_number_normalized: string | null;
          condition_issues: Json;
          condition_notes: string | null;
          created_at: string;
          created_by: string;
          id: string;
          identification_confidence: number;
          inventory_code: string | null;
          inventory_prefix: string;
          inventory_sequence: number;
          inventory_status: string;
          rarity: string | null;
          scan_image_path: string;
          set_name: string;
          set_name_normalized: string | null;
          source_scan_id: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "cards";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      unarchive_slab: {
        Args: { p_id: string };
        Returns: {
          acquired_at: string | null;
          archived_at: string | null;
          back_image_path: string | null;
          candidate_image_available: boolean | null;
          candidate_image_retrieved_at: string | null;
          candidate_image_source: string | null;
          candidate_image_type: string | null;
          candidate_image_url: string | null;
          card_name: string | null;
          card_number: string | null;
          certification_number: string | null;
          certification_number_normalized: string | null;
          certification_verification_status: string;
          cgc_population_card_id: string | null;
          cgc_population_match_confidence: number | null;
          cgc_population_match_method: string | null;
          cgc_population_match_status: string | null;
          cgc_population_matched_at: string | null;
          cgc_population_snapshot: Json | null;
          cost_basis_cents: number | null;
          created_at: string;
          date_valued: string | null;
          duplicate_status: string | null;
          final_value_cents: number | null;
          finish: string | null;
          front_image_path: string | null;
          game_or_franchise: string | null;
          grade: string | null;
          grade_label: string | null;
          grader: string | null;
          grader_normalized: string | null;
          id: string;
          inventory_code: string | null;
          inventory_number: number;
          inventory_prefix: string;
          inventory_sequence: number;
          inventory_status: string;
          label_accuracy: string | null;
          label_description: string | null;
          language: string | null;
          notes: string | null;
          owner_id: string;
          price_variance_percent: number | null;
          pricecharting_grade_field: string | null;
          pricecharting_match_status: string | null;
          pricecharting_priced_at: string | null;
          pricecharting_product_id: string | null;
          pricecharting_product_name: string | null;
          pricecharting_raw: Json | null;
          pricecharting_sales_volume: number | null;
          pricecharting_tiers: Json | null;
          pricecharting_value_cents: number | null;
          product_confirmation_source: string | null;
          product_confirmed_at: string | null;
          quick_sale_value_cents: number | null;
          rarity: string | null;
          replacement_value_cents: number | null;
          sale_shipping_cents: number | null;
          scoring_version: number | null;
          set_name: string | null;
          sold_at: string | null;
          sold_price_cents: number | null;
          updated_at: string;
          valuation_confidence: string | null;
          valuation_provenance: string;
          valuation_status: string;
          variation: string | null;
          verification_status: string;
          visual_confirmation_at: string | null;
          visual_confirmation_by: string | null;
          visual_confirmation_method: string | null;
          visual_confirmation_status: string | null;
          visual_identity_status: string;
          visual_rejection_note: string | null;
          visual_rejection_reason: string | null;
          year: number | null;
        };
        SetofOptions: {
          from: "*";
          to: "slabs";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      valid_image_ext: { Args: { p_ext: string }; Returns: string };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
