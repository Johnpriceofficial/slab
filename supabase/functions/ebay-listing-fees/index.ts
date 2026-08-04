import { handleEbay } from "../_shared/ebay.ts";

// Admin-only eBay listing-fee preview. All auth (admin JWT), server-side token
// resolution, output allowlisting and fail-closed behavior live in handleEbay /
// _shared/ebay-listing-fees-core.ts. This is a thin dispatch shim.
Deno.serve((req) => handleEbay(req, "listing_fees"));
