import { describe, it, expect } from "vitest";
import { RUN_STATES, allowedNext, canTransition, isTerminal, transition } from "../../builder/state-machine";
import type { RunStatus } from "../../builder/types";

describe("run state machine", () => {
  it("covers exactly the documented run statuses", () => {
    expect(new Set(RUN_STATES)).toEqual(new Set<RunStatus>([
      "requested", "planned", "approved", "executing", "waiting_for_ci",
      "waiting_for_preview", "waiting_for_approval", "deploying", "verifying",
      "completed", "failed", "rolled_back",
    ]));
  });

  it("completed and rolled_back are terminal; nothing leaves them", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("rolled_back")).toBe(true);
    expect(allowedNext("completed")).toEqual([]);
    expect(transition("completed", "executing")).toMatchObject({ ok: false });
  });

  it("a run cannot skip gates — no jump from approved straight to deploying", () => {
    expect(canTransition("approved", "executing")).toBe(true);
    expect(canTransition("approved", "deploying")).toBe(false);
    expect(canTransition("executing", "deploying")).toBe(false);       // must pass approval first
    expect(canTransition("waiting_for_approval", "deploying")).toBe(true);
  });

  it("the happy path is reachable edge by edge", () => {
    const path: RunStatus[] = ["requested", "planned", "approved", "executing", "waiting_for_ci", "waiting_for_preview", "waiting_for_approval", "deploying", "verifying", "completed"];
    for (let i = 0; i < path.length - 1; i++) {
      expect(transition(path[i], path[i + 1])).toEqual({ ok: true, status: path[i + 1] });
    }
  });

  it("failure is recoverable only via rollback, then terminal", () => {
    expect(canTransition("failed", "rolled_back")).toBe(true);
    expect(canTransition("failed", "executing")).toBe(false);
    expect(isTerminal("failed")).toBe(false); // failed is semi-terminal (rollback still possible)
    expect(isTerminal("rolled_back")).toBe(true);
  });

  it("transition reports a clear error for illegal and terminal moves", () => {
    expect(transition("requested", "deploying")).toEqual({ ok: false, error: "illegal transition 'requested' → 'deploying'" });
    expect(transition("rolled_back", "executing")).toEqual({ ok: false, error: "run is terminal in 'rolled_back'" });
  });
});
