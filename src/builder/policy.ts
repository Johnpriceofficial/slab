// The four-level permission engine. Given a tool's risk, the session's granted
// authority, and the environment, it returns exactly what must happen before the
// tool may run. This is the ONE place that authorizes side effects — the model's
// request is only an input to it.
//
//   read              → auto (any session, incl. read-only)
//   preview_write     → session_approval when the session granted preview/all;
//                       otherwise explicit_approval
//   production_write  → explicit_approval ALWAYS (a session grant never auto-approves
//                       production — mirrors "allow all ≠ deploy to prod")
//   destructive       → typed_confirmation; DENIED when the environment forbids it
//
// A tool's requiresApproval flag can only ESCALATE (never relax) the mapping.

import type { Decision, PolicyContext, RiskLevel } from "./types.ts";

const SESSION_GRANTS_PREVIEW = new Set(["allow_preview", "allow_all_nondestructive"]);

export function evaluatePolicy(risk: RiskLevel, ctx: PolicyContext, requiresApproval = false): Decision {
  const base = baseDecision(risk, ctx);
  if (base === "denied") return "denied"; // an environment/mode denial is never overridden
  if (!requiresApproval) return base;
  // requiresApproval escalates auto/session_approval up to an explicit human gate;
  // it can never weaken an already-stronger gate (typed_confirmation stays).
  if (base === "auto" || base === "session_approval") return "explicit_approval";
  return base;
}

function baseDecision(risk: RiskLevel, ctx: PolicyContext): Decision {
  switch (risk) {
    case "read":
      return "auto";
    case "preview_write":
      return SESSION_GRANTS_PREVIEW.has(ctx.sessionMode) ? "session_approval" : "explicit_approval";
    case "production_write":
      return "explicit_approval";
    case "destructive":
      return ctx.allowDestructive === true ? "typed_confirmation" : "denied";
  }
}

/** May this decision proceed WITHOUT a fresh human gate right now? */
export function mayExecuteImmediately(decision: Decision): boolean {
  return decision === "auto" || decision === "session_approval";
}

/** Does this decision require a pending human approval (or typed confirmation)? */
export function requiresHumanGate(decision: Decision): boolean {
  return decision === "explicit_approval" || decision === "typed_confirmation";
}
