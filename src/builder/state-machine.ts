// The builder run state machine. Every run advances only along explicit edges, so a
// run can never skip a required gate (e.g. jump straight to `deploying` without an
// approval) and can never leave a terminal state. Pure + exhaustively testable.

import type { RunStatus } from "./types.ts";

// Allowed forward transitions. A run is created in `requested`.
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  requested: ["planned", "failed"],
  planned: ["approved", "failed"],
  approved: ["executing", "failed"],
  executing: ["waiting_for_ci", "waiting_for_approval", "completed", "failed"],
  waiting_for_ci: ["executing", "waiting_for_preview", "failed"],
  waiting_for_preview: ["waiting_for_approval", "failed"],
  waiting_for_approval: ["deploying", "executing", "failed", "rolled_back"],
  deploying: ["verifying", "failed", "rolled_back"],
  verifying: ["completed", "failed", "rolled_back"],
  completed: [],                 // terminal
  failed: ["rolled_back"],       // a failure may still be rolled back, then terminal
  rolled_back: [],               // terminal
};

export const RUN_STATES = Object.keys(TRANSITIONS) as RunStatus[];

/** Terminal states cannot transition anywhere. */
export function isTerminal(status: RunStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Returns the next status if the transition is legal, or an error describing why not. */
export function transition(from: RunStatus, to: RunStatus): { ok: true; status: RunStatus } | { ok: false; error: string } {
  if (isTerminal(from)) return { ok: false, error: `run is terminal in '${from}'` };
  if (!canTransition(from, to)) return { ok: false, error: `illegal transition '${from}' → '${to}'` };
  return { ok: true, status: to };
}

export function allowedNext(from: RunStatus): readonly RunStatus[] {
  return TRANSITIONS[from];
}
