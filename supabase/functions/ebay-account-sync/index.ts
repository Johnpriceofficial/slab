import { handleEbay } from "../_shared/ebay.ts";

Deno.serve((req) => handleEbay(req, "account_sync"));
