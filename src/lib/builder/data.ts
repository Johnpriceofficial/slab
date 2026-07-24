// Read-only data access for the /builder admin surface. RLS (admin-read) is the
// authoritative gate; this layer just shapes rows for the UI. No write helpers exist
// yet — Phase 1 is inspection only, and all builder writes happen from a service_role
// backend, never the browser.

import { supabase } from "@/integrations/supabase/client";
import type { RunStatus } from "@/builder/types";

export interface BuilderRunRow {
  id: string;
  project: string;
  environment: "development" | "preview" | "production";
  instruction: string;
  status: RunStatus;
  session_mode: "read_only" | "allow_preview" | "allow_all_nondestructive";
  correlation_id: string;
  created_at: string;
  updated_at: string;
}

export async function fetchBuilderRuns(limit = 50): Promise<BuilderRunRow[]> {
  const { data, error } = await supabase
    .from("builder_runs")
    .select("id, project, environment, instruction, status, session_mode, correlation_id, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as BuilderRunRow[];
}
