/**
 * Raw Card Pricer, Centering Analyzer, Grader, and Submission Decision Engine.
 *
 * This package implements the deterministic financial/decision core of the
 * v2 spec: centering scoring, cost/profit/ROI formulas, liquidity
 * adjustment, and the final decision-precedence engine. It deliberately
 * does NOT include the LLM vision-analysis step (card identification,
 * condition reading from photos) — that belongs in a new edge function
 * (analogous to `analyze-slab`) that calls OpenAI with the system prompt
 * below and then feeds structured results into these pure functions, the
 * same separation of concerns this codebase already uses for graded slabs
 * (`src/lib/identity/` + `supabase/functions/analyze-slab`).
 */
export * from "./types";
export * from "./defaults";
export * from "./centering";
export * from "./formulas";
export * from "./decision";
export { RAW_CARD_PRICER_SYSTEM_PROMPT } from "./system-prompt";
