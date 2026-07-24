// AI Build Control Plane — shared type contracts (Phase 1 spine).
//
// The design rule: the model REQUESTS an action; the control plane DECIDES whether
// it is permitted. Every capability is a typed, risk-classified ToolDefinition; the
// policy engine maps (risk, session grant, environment) → a Decision; and every run
// moves through an explicit, auditable state machine. Nothing here executes anything
// — it is the pure vocabulary the orchestrator (Claude Agent SDK) and the durable
// store are built on. Web-standard only, no provider SDKs → fully unit-testable.

export type Provider = "github" | "vercel" | "supabase" | "ebay" | "pricecharting" | "system";

/** How dangerous an action is. The single most important field on a tool. */
export type RiskLevel = "read" | "preview_write" | "production_write" | "destructive";

/** The authority the operator granted for THIS run + environment. Deliberately NOT
 *  a permanent, all-powerful grant: "allow all" means "all non-destructive actions
 *  in this project/environment for this session", never "unrestricted forever". */
export type SessionMode = "read_only" | "allow_preview" | "allow_all_nondestructive";

export type Environment = "development" | "preview" | "production";

/** What the control plane requires BEFORE a tool may execute. */
export type Decision =
  | "auto"                // inherently safe (reads) — execute immediately
  | "session_approval"    // permitted because the session granted it (attributable)
  | "explicit_approval"   // a one-off human approval is required
  | "typed_confirmation"  // human must type a confirmation phrase (2-person preferred)
  | "denied";             // not permitted in this environment at all

export interface PolicyContext {
  sessionMode: SessionMode;
  environment: Environment;
  /** Hard environment ceiling: when false, destructive actions are denied outright
   *  (e.g. production forbids destructive by default). Defaults to false. */
  allowDestructive?: boolean;
}

/** Parse result for a tool's input — a tiny Result type so the spine needs no zod. */
export type ParseResult<I> = { ok: true; value: I } | { ok: false; error: string };

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;                 // e.g. "github.list_pull_requests"
  provider: Provider;
  risk: RiskLevel;
  description: string;
  /** Force a human gate regardless of the risk→decision mapping (belt-and-suspenders
   *  for actions that are technically low-risk but you still want a person to see). */
  requiresApproval?: boolean;
  parseInput: (raw: unknown) => ParseResult<I>;
  execute: (input: I) => Promise<O>;
}

/** The durable lifecycle of a builder run. The watermark of truth for a run's state;
 *  transitions are validated by the state machine so a run can never skip a gate. */
export type RunStatus =
  | "requested"
  | "planned"
  | "approved"
  | "executing"
  | "waiting_for_ci"
  | "waiting_for_preview"
  | "waiting_for_approval"
  | "deploying"
  | "verifying"
  | "completed"
  | "failed"
  | "rolled_back";

export type ApprovalDecision = "pending" | "approved" | "rejected";
