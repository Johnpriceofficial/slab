import { mutationEnabled } from "./ebay-mutation-flags.ts";

/**
 * Server-only kill switch for the destructive local credential deletion path.
 * Undefined, empty, false, and every value other than the exact boolean string
 * "true" remain disabled through the shared mutationEnabled parser.
 */
export const EBAY_DISCONNECT_FLAG = "EBAY_DISCONNECT_ENABLED";

export function isEbayDisconnectEnabled(value: string | undefined | null): boolean {
  return mutationEnabled(value);
}

export type DisconnectInputResult =
  | { ok: true; accountId: string }
  | { ok: false; errorCode: "INVALID_ACCOUNT_ID"; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDisconnectInput(body: unknown): DisconnectInputResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      errorCode: "INVALID_ACCOUNT_ID",
      message: "account_id must be a UUID.",
    };
  }

  const accountId = (body as Record<string, unknown>).account_id;
  if (typeof accountId !== "string" || !UUID_RE.test(accountId.trim())) {
    return {
      ok: false,
      errorCode: "INVALID_ACCOUNT_ID",
      message: "account_id must be a UUID.",
    };
  }

  return { ok: true, accountId: accountId.trim().toLowerCase() };
}

export interface EbayDisconnectDeps {
  checkAdmin: (req: Request) => Promise<{ user: { id: string } | null; isAdmin: boolean }>;
  deleteCredential: (accountId: string) => Promise<void>;
  disconnectEnabled: boolean;
  corsHeaders?: Record<string, string>;
}

function jsonResponse(
  status: number,
  body: unknown,
  cors: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors, ...extraHeaders },
  });
}

/**
 * Admin-only, default-off local eBay credential disconnect.
 *
 * The database mutation is dependency-injected and must be implemented by the
 * service-role-only `ebay_credential_delete(uuid)` RPC. The response is a fixed
 * allowlist and never contains token, credential, account, or provider payloads.
 */
export async function handleEbayDisconnect(
  req: Request,
  deps: EbayDisconnectDeps,
): Promise<Response> {
  const cors = deps.corsHeaders ?? {};

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: cors });
  }
  if (req.method !== "POST") {
    return jsonResponse(
      405,
      { status: "error", error_code: "METHOD_NOT_ALLOWED" },
      cors,
      { Allow: "POST, OPTIONS" },
    );
  }

  const { user, isAdmin } = await deps.checkAdmin(req);
  if (!user) return jsonResponse(401, { error: "Unauthorized" }, cors);
  if (!isAdmin) return jsonResponse(403, { error: "Forbidden" }, cors);

  if (!deps.disconnectEnabled) {
    return jsonResponse(
      403,
      {
        status: "mutation_disabled",
        operation: "disconnect",
        kind: "credential",
        message: "eBay credential disconnect is disabled by server configuration.",
      },
      cors,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      400,
      { status: "error", error_code: "INVALID_JSON", message: "A JSON request body is required." },
      cors,
    );
  }

  const parsed = parseDisconnectInput(body);
  if (parsed.ok === false) {
    return jsonResponse(
      400,
      { status: "error", error_code: parsed.errorCode, message: parsed.message },
      cors,
    );
  }

  try {
    await deps.deleteCredential(parsed.accountId);
    return jsonResponse(200, { status: "disconnected" }, cors);
  } catch {
    return jsonResponse(
      503,
      {
        status: "error",
        error_code: "DISCONNECT_FAILED",
        message: "The eBay account could not be disconnected.",
      },
      cors,
    );
  }
}
