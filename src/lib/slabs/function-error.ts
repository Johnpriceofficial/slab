export type StructuredFunctionError = Record<string, unknown> & {
  status: string;
  message: string;
  error_code?: string;
  http_status?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string" && error.message.trim()) return error.message;
  return "The server function request failed.";
}

/**
 * Supabase FunctionsHttpError keeps the Edge Function Response in `context`.
 * Read only the Edge-approved JSON response; never expose headers, tokens, raw
 * provider bodies, or opaque error objects to the browser.
 */
export async function normalizeFunctionInvokeError(error: unknown): Promise<StructuredFunctionError> {
  const fallback = messageOf(error);
  const context = isRecord(error) ? error.context : null;
  let httpStatus: number | undefined;
  let body: Record<string, unknown> | null = null;

  if (context instanceof Response) {
    httpStatus = context.status || undefined;
    try {
      const parsed = await context.clone().json();
      if (isRecord(parsed)) body = parsed;
    } catch {
      body = null;
    }
  }

  const status = body && typeof body.status === "string" && body.status.trim() ? body.status : "error";
  const message = body && typeof body.message === "string" && body.message.trim() ? body.message : fallback;
  return { ...(body ?? {}), status, message, ...(httpStatus ? { http_status: httpStatus } : {}) };
}
