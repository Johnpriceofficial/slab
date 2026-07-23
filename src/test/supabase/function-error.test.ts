import { describe, expect, it } from "vitest";
import { normalizeFunctionInvokeError } from "@/lib/supabase/function-error";

describe("normalizeFunctionInvokeError", () => {
  it("preserves the safe JSON contract from a non-2xx Edge response", async () => {
    const context = new Response(JSON.stringify({
      status: "unavailable",
      error_code: "reauthorization_required",
      message: "Reconnect the eBay seller account.",
      reconnect_required: true,
      retryable: false,
    }), { status: 409, headers: { "content-type": "application/json" } });

    const result = await normalizeFunctionInvokeError({
      message: "Edge Function returned a non-2xx status code",
      context,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      error_code: "reauthorization_required",
      message: "Reconnect the eBay seller account.",
      reconnect_required: true,
      retryable: false,
      http_status: 409,
    });
  });

  it("falls back safely when the response body is not JSON", async () => {
    const result = await normalizeFunctionInvokeError({
      message: "Edge Function returned a non-2xx status code",
      context: new Response("gateway failure", { status: 502 }),
    });
    expect(result).toEqual({
      status: "error",
      message: "Edge Function returned a non-2xx status code",
      http_status: 502,
    });
  });

  it("never copies response headers into the browser-facing result", async () => {
    const result = await normalizeFunctionInvokeError({
      message: "failed",
      context: new Response(JSON.stringify({ status: "error", message: "Safe message" }), {
        status: 500,
        headers: { authorization: "Bearer secret", "x-provider-body": "private" },
      }),
    });
    expect(result).toEqual({ status: "error", message: "Safe message", http_status: 500 });
  });
});
