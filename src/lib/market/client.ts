/**
 * Client for the read-only market-intelligence Edge Function. Sends a slab or
 * raw-card id; the server rebuilds the canonical identity, queries the
 * providers, and returns the assembled MarketIntelligence. The client never
 * touches provider secrets and the function writes nothing.
 */

import { supabase } from "@/integrations/supabase/client";
import type { MarketIntelligence } from "@/server/market-intelligence/engine";

export type { MarketIntelligence };

export type MarketIntelligenceRequest = { slab_id: string } | { card_id: string };

export async function fetchMarketIntelligence(request: MarketIntelligenceRequest): Promise<MarketIntelligence> {
  const { data, error } = await supabase.functions.invoke("market-intelligence", { body: request });
  if (error) throw new Error(error.message);
  const body = data as MarketIntelligence | { error?: string };
  if (body && "error" in body && body.error) throw new Error(body.error);
  return body as MarketIntelligence;
}
