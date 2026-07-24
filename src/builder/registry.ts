// The connector/tool registry and the single authorization entry point.
//
// A registry is an immutable map of typed, risk-classified tools. `authorizeToolCall`
// is what the orchestrator's per-tool guardrail invokes for EVERY requested action:
// it resolves the tool, validates the input against the tool's own schema, and asks
// the policy engine for a Decision — all WITHOUT executing anything. Execution is a
// separate, later step that only happens once the Decision permits it (auto/session)
// or a human approves it. This keeps "what the model asked for" and "what the plane
// allows" strictly separated.

import { evaluatePolicy } from "./policy.ts";
import type { Decision, PolicyContext, ToolDefinition } from "./types.ts";

export function defineTool<I, O>(tool: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return tool;
}

export interface ToolRegistry {
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  has(name: string): boolean;
}

export function createRegistry(tools: ToolDefinition[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition>();
  for (const t of tools) {
    if (byName.has(t.name)) throw new Error(`duplicate tool in registry: ${t.name}`);
    byName.set(t.name, t);
  }
  return {
    get: (name) => byName.get(name),
    list: () => [...byName.values()],
    has: (name) => byName.has(name),
  };
}

export type Authorization =
  | { ok: true; tool: ToolDefinition; input: unknown; decision: Decision }
  | { ok: false; error: string; reason: "unknown_tool" | "invalid_input" };

/** Resolve + validate + classify a requested tool call. NEVER executes the tool. */
export function authorizeToolCall(registry: ToolRegistry, ctx: PolicyContext, name: string, rawInput: unknown): Authorization {
  const tool = registry.get(name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}`, reason: "unknown_tool" };
  const parsed = tool.parseInput(rawInput);
  if (parsed.ok === false) return { ok: false, error: `invalid input for ${name}: ${parsed.error}`, reason: "invalid_input" };
  const decision = evaluatePolicy(tool.risk, ctx, tool.requiresApproval);
  return { ok: true, tool, input: parsed.value, decision };
}
