import { createClient } from "npm:@supabase/supabase-js@2.110.2";
import { corsHeaders } from "../_shared/cors.ts";
import { isCallerAdmin } from "../_shared/auth.ts";
import {
  handleConnectStatus,
  type EbayAccountRow,
  type EbayResourceCounts,
  type EbayScopeMeta,
} from "../_shared/ebay-connect-status-core.ts";

/**
 * Admin-only eBay connection status. Returns ONLY sanitized metadata; every
 * decision (auth, allowlist, fail-closed) lives in the unit-tested core. The
 * private refresh credential is never read here — scope metadata comes from the
 * service-role RPC `ebay_credential_scopes_get`, which returns no token.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ENVIRONMENT = Deno.env.get("EBAY_ENVIRONMENT") ?? "production";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  return handleConnectStatus(req, {
    checkAdmin: (r) => isCallerAdmin(r),

    async loadAccount(): Promise<EbayAccountRow | null> {
      const { data, error } = await admin
        .from("ebay_accounts")
        .select(
          "id, ebay_user_id, marketplace_id, display_label, connection_status, privilege_status, authorization_expires_at, last_synced_at, connected_at",
        )
        .order("connected_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error("account_load_failed");
      return (data as EbayAccountRow | null) ?? null;
    },

    async loadScopeMeta(accountId: string): Promise<EbayScopeMeta> {
      // Service-role RPC ONLY. Returns scope metadata; never the token.
      const { data, error } = await admin.rpc("ebay_credential_scopes_get", {
        p_account_id: accountId,
      });
      if (error) throw new Error("scope_meta_failed");
      const row = Array.isArray(data) ? data[0] : data;
      return {
        requestedScopes: (row?.requested_scopes as string[] | undefined) ?? [],
        grantedScopes: (row?.token_reported_scopes as string[] | undefined) ?? [],
        scopeSource: (row?.scope_source as string | null | undefined) ?? null,
      };
    },

    async loadCounts(accountId: string): Promise<EbayResourceCounts> {
      // Counts are secondary metadata: never fail the whole status on them.
      const counts: EbayResourceCounts = {
        inventoryLocations: 0,
        businessPolicies: { fulfillment: 0, payment: 0, return: 0 },
      };
      try {
        const [locations, policies] = await Promise.all([
          admin
            .from("ebay_inventory_locations")
            .select("id", { count: "exact", head: true })
            .eq("ebay_account_id", accountId),
          admin
            .from("ebay_business_policies")
            .select("policy_type")
            .eq("ebay_account_id", accountId),
        ]);
        counts.inventoryLocations = locations.count ?? 0;
        for (const p of (policies.data ?? []) as Array<{ policy_type?: string | null }>) {
          const t = (p.policy_type ?? "").toLowerCase();
          if (t === "fulfillment" || t === "payment" || t === "return") {
            counts.businessPolicies[t] += 1;
          }
        }
      } catch {
        // Swallow: return zeroed counts rather than failing the status.
      }
      return counts;
    },

    mutationEnv: {
      EBAY_LISTING_MUTATIONS_ENABLED: Deno.env.get("EBAY_LISTING_MUTATIONS_ENABLED"),
      EBAY_FULFILLMENT_MUTATIONS_ENABLED: Deno.env.get("EBAY_FULFILLMENT_MUTATIONS_ENABLED"),
      EBAY_FINANCIAL_MUTATIONS_ENABLED: Deno.env.get("EBAY_FINANCIAL_MUTATIONS_ENABLED"),
      EBAY_APPLY_SALES_ENABLED: Deno.env.get("EBAY_APPLY_SALES_ENABLED"),
    },
    environment: ENVIRONMENT,
    supabaseUrl: SUPABASE_URL,
    now: () => new Date().toISOString(),
    corsHeaders,
  });
});
