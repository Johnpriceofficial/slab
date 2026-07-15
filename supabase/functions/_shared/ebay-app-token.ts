// eBay application-token acquisition for PUBLIC Browse API calls.
//
// Public Browse requests need an application access token from the
// client_credentials OAuth grant — NOT a hand-pasted, short-lived token that
// silently expires. This module fetches one server-side from
// EBAY_CLIENT_ID / EBAY_CLIENT_SECRET on demand. Credentials never leave the
// server and the token never reaches the client or the response body. When
// credentials are absent, callers get a typed "not configured" signal via
// `ebayBrowseConfigured()` instead of a fabricated token or fake live data.

const MODE = Deno.env.get("EBAY_ENVIRONMENT") === "sandbox" ? "sandbox" : "production";
const API = MODE === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const CLIENT_ID = Deno.env.get("EBAY_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("EBAY_CLIENT_SECRET") ?? "";

/** True only when the server-side client-credentials app-token flow can run. */
export function ebayBrowseConfigured(): boolean {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

/** The public eBay API base for the active (production/sandbox) environment. */
export function ebayApiBase(): string {
  return API;
}

/**
 * Fetch a fresh eBay application access token (client_credentials grant). Throws
 * if eBay is not configured or the grant fails — the caller maps that to a typed
 * `not_configured` / `provider_error` state; it never returns a placeholder.
 */
export async function getEbayAppToken(): Promise<string> {
  if (!ebayBrowseConfigured()) throw new Error("eBay is not configured.");
  const res = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }),
  });
  if (!res.ok) throw new Error(`eBay OAuth returned HTTP ${res.status}.`);
  const data = await res.json();
  const token = (data as Record<string, unknown>).access_token;
  if (typeof token !== "string") throw new Error("eBay did not return an application token.");
  return token;
}
