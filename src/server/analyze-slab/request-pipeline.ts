/**
 * Request-processing pipeline for analyze-slab, steps 4–8.
 *
 * Steps 1–3 (method, authentication, authorization + rollout gate) run in the
 * Edge Function before this pipeline. This module owns the strict, security-
 * critical ordering of everything after authorization, extracted as a pure,
 * dependency-injected function so the exact order is unit-tested (the Deno
 * entrypoint itself cannot run under vitest):
 *
 *   4. JSON parsing            → malformed body ⇒ typed 400 INVALID_PARAMETER
 *   5. image validation        → malformed images ⇒ typed 400/413
 *   6. provider-config check    → NOT_CONFIGURED only AFTER 4–5 pass
 *   7. quota consumption        → spent only after 4–6 all pass
 *   8. provider request         → reached only for a fully valid, quota'd call
 *
 * Guarantees proven by construction and by request-pipeline.test.ts:
 *   - a malformed body or image returns its typed error even when the
 *     provider key is absent (validation never hides behind NOT_CONFIGURED);
 *   - a rejected payload never consumes quota and never calls the provider;
 *   - a valid request that hits NOT_CONFIGURED (no provider key) consumes NO
 *     quota and never calls the provider — the provider-config check precedes
 *     quota consumption;
 *   - quota is consumed only once authorization (upstream), parsing,
 *     validation and provider configuration have all passed.
 */

import {
  validateAnalyzeImageInput,
  type ImageValidationLimits,
} from "./validate-images";

export interface AnalyzePipelineResult {
  statusCode: number;
  body: unknown;
}

export interface AnalyzePipelineDeps {
  /** The authorized caller's role (decided upstream in steps 1–3). */
  role: "admin" | "customer";
  /** Step 4: parse the request body. `ok:false` ⇒ malformed JSON. */
  parseJson: () => Promise<{ ok: true; value: unknown } | { ok: false }>;
  /** Optional validation-limit override (tests only; prod uses defaults). */
  imageLimits?: ImageValidationLimits;
  /** Step 6: consume one quota unit for the role. false ⇒ over limit. */
  consumeQuota: (role: "admin" | "customer") => Promise<boolean>;
  /** Step 7: current provider key (undefined ⇒ NOT_CONFIGURED). */
  getApiKey: () => string | undefined;
  /** Step 8: run the analysis + persistence for a fully validated request. */
  runAnalysis: (input: unknown, apiKey: string) => Promise<AnalyzePipelineResult>;
}

const QUOTA_MESSAGE: Record<"admin" | "customer", string> = {
  admin: "Daily image-analysis limit reached. Try again tomorrow.",
  customer: "Daily analysis limit reached for this account. Try again tomorrow.",
};

export async function runAnalyzeRequestPipeline(
  deps: AnalyzePipelineDeps,
): Promise<AnalyzePipelineResult> {
  // 4. JSON parsing — typed 400, never a 500, provider-independent.
  const parsed = await deps.parseJson();
  if (!parsed.ok) {
    return err(400, "INVALID_PARAMETER", "Invalid JSON body.");
  }

  // 5. Image validation — typed 400/413, enforced even with no provider key.
  const invalid = validateAnalyzeImageInput(parsed.value, deps.imageLimits);
  if (invalid) {
    return err(invalid.statusCode, invalid.code, invalid.message);
  }

  // 6. Provider-configuration check — BEFORE quota. A valid request that
  //    cannot be served (no provider key) must not spend quota, so this
  //    precedes consumption. Still reached only after authorization and
  //    validation, so NOT_CONFIGURED never masks a malformed/unauthorized
  //    request.
  const apiKey = deps.getApiKey();
  if (!apiKey) {
    return err(502, "NOT_CONFIGURED", "OpenAI image analysis is not configured.");
  }

  // 7. Quota — consumed only once authorization, validation and provider
  //    configuration have all passed, so a NOT_CONFIGURED response never
  //    consumes quota and a rejected payload never does either.
  const allowed = await deps.consumeQuota(deps.role);
  if (!allowed) {
    return err(429, "QUOTA_EXCEEDED", QUOTA_MESSAGE[deps.role]);
  }

  // 8. Provider request + persistence.
  return deps.runAnalysis(parsed.value, apiKey);
}

function err(statusCode: number, code: string, message: string): AnalyzePipelineResult {
  return { statusCode, body: { status: "error", error_code: code, message } };
}
