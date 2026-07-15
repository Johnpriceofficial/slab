/**
 * Fetches market intelligence for a slab or raw card and renders the read-only
 * panel. Cached by the request key; the server does the real caching by identity
 * hash + grade tier.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchMarketIntelligence, type MarketIntelligenceRequest } from "@/lib/market/client";
import { MarketIntelligencePanel } from "./MarketIntelligencePanel";

export function MarketIntelligenceSection({ request }: { request: MarketIntelligenceRequest }) {
  const key = "slab_id" in request ? ["market-intel", "slab", request.slab_id] : ["market-intel", "card", request.card_id];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => fetchMarketIntelligence(request),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return <MarketIntelligencePanel data={data} isLoading={isLoading} error={error ? (error as Error).message : null} />;
}
