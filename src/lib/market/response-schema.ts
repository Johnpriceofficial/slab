import type { MarketIntelligence, SourceState, SourceStatus } from "@/server/market-intelligence/engine";
import type { MarketDataPoint, MarketSource, MarketSummary } from "./types";
import type { GradeTier } from "./grade-tier";
import type { CompletenessNote, CompletenessStatus } from "@/lib/identity/completeness";
import { isRecord } from "@/lib/providers/response-schema";

const