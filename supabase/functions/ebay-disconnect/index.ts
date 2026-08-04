import { createClient } from "npm:@supabase/supabase-js@2.110.2";
import { corsHeaders } from "../_shared/cors.ts";
import { isCallerAdmin } from "../_shared/auth.ts";
import {
  EBAY_DISCONNECT_FLAG,
  handleEbayDisconnect,
  isEbayDisconnectEnabled,
} from "../_shared/ebay-disconnect-core.ts";

/**
 * Admin-only local eBay credential disconnect.
 *
 * This does not call eBay and cannot mutate a listing, order, shipment, refund,
 * payout, or sale. It invokes one service-role-only transactional RPC that
 * deletes the canonical private refresh credential, marks the public account
 * disconnected, and records a safe audit row. The path remains default-off.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  return handleEbayDisconnect(req, {
    checkAdmin: (request) => isCallerAdmin(request),
    disconnectEnabled: isEbayDisconnectEnabled(Deno.env.get(EBAY_DISCONNECT_FLAG)),
    corsHeaders,

    async deleteCredential(accountId: string): Promise<void> {
      const { error } = await admin.rpc("ebay_credential_delete", {
        p_account_id: accountId,
      });
      if (error) throw new Error("credential_delete_failed");
    },
  });
});
