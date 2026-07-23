import { supabase } from "@/integrations/supabase/client";
import { normalizeFunctionInvokeError } from "./function-error";

type AnyClient = {
  from: (table: string) => any;
  functions: typeof supabase.functions;
};
const sb = supabase as unknown as AnyClient;

export interface EbayAccountView {
  id: string;
  display_label: string | null;
  connection_status: string;
  privilege_status: string | null;
  connected_at: string | null;
}

export async function fetchEbayAccounts(): Promise<EbayAccountView[]> {
  const { data, error } = await sb.from("ebay_accounts").select("id,display_label,connection_status,privilege_status,connected_at").order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function fetchEbaySyncCursors(accountId: string): Promise<Array<{ resource_type: string; cursor_value: string | null; last_synced_at: string | null }>> {
  const { data, error } = await sb.from("ebay_sync_cursors").select("resource_type,cursor_value,last_synced_at").eq("ebay_account_id", accountId);
  if (error) return [];
  return data ?? [];
}

export async function fetchEbayLocations(accountId: string): Promise<Array<{ merchant_location_key: string; status: string | null }>> {
  const { data, error } = await sb.from("ebay_inventory_locations").select("merchant_location_key,status").eq("ebay_account_id", accountId).order("merchant_location_key", { ascending: true });
  if (error) return [];
  return data ?? [];
}

export async function fetchEbayBusinessPolicies(accountId: string): Promise<Array<{ policy_id: string; policy_type: string; name: string | null }>> {
  const { data, error } = await sb.from("ebay_business_policies").select("policy_id,policy_type,name").eq("ebay_account_id", accountId).order("name", { ascending: true });
  if (error) return [];
  return data ?? [];
}

export async function startEbayOAuth(): Promise<Record<string, any>> {
  const { data, error } = await sb.functions.invoke("ebay-oauth-start", { body: { redirect_after: window.location.pathname + window.location.search } });
  if (error) return await normalizeFunctionInvokeError(error);
  return data ?? { status: "error", message: "eBay returned no OAuth response." };
}

export async function ebaySellerOperation(
  functionName: "ebay-account-sync" | "ebay-list-item" | "ebay-revise-item" | "ebay-end-item" | "ebay-order-sync" | "ebay-fulfillment" | "ebay-finances-sync",
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  const { data, error } = await sb.functions.invoke(functionName, { body });
  if (error) return await normalizeFunctionInvokeError(error);
  return data ?? { status: "error", message: "eBay returned no response." };
}
