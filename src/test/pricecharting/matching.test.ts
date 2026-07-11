import { describe, it, expect } from "vitest";
import { PriceChartingClient } from "@/lib/pricecharting/client";
import { findBestProductMatch } from "@/lib/pricecharting/matching";
import { getCardValuation } from "@/lib/pricecharting/valuation";
import { nullLogger } from "@/lib/pricecharting/logger";
import type { CardItemInput } from "@/lib/pricecharting/types";
import { createMockFetch, RecordingClock } from "./helpers";

function client(mock: ReturnType<typeof createMockFetch>) {
  return new PriceChartingClient({
    fetch: mock.fetchImpl,
    clock: new RecordingClock(),
    logger: nullLogger,
    tokenProvider: () => "tok-abcdefghijklmnop",
  });
}

const CHARIZARD_4: CardItemInput = {
  category: "trading_card",
  card_name: "Charizard",
  card_number: "4",
  set: "Base Set",
  year: 1999,
};

describe("findBestProductMatch", () => {
  it("confidently matches a single strong candidate", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", {
      json: { products: [{ id: "6910", "product-name": "Charizard #4", "console-name": "Pokemon Base Set", "release-date": "1999-01-09" }] },
    });
    const { product, match } = await findBestProductMatch(client(mock), CHARIZARD_4);
    expect(product?.pricecharting_id).toBe("6910");
    expect(match.confidence_score).toBeGreaterThanOrEqual(85);
    expect(["Exact", "High"]).toContain(match.confidence_level);
    expect(match.match_reasons.some((r) => /Exact card_number/i.test(r))).toBe(true);
  });

  it("refuses to confirm when two candidates are equally plausible (ambiguous)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", {
      json: {
        products: [
          { id: "1", "product-name": "Charizard #4", "console-name": "Pokemon Base Set", "release-date": "1999-01-09" },
          { id: "2", "product-name": "Charizard #4", "console-name": "Pokemon Base Set", "release-date": "1999-01-09" },
        ],
      },
    });
    const { product, match } = await findBestProductMatch(client(mock), CHARIZARD_4);
    expect(product).toBeNull(); // never present one candidate as confirmed
    expect(match.confidence_score).toBeLessThan(70);
    expect(match.conflicts.some((c) => /Ambiguous/i.test(c))).toBe(true);
  });

  it("rejects a candidate whose card number conflicts", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", {
      json: { products: [{ id: "9", "product-name": "Charizard #11", "console-name": "Pokemon Base Set", "release-date": "1999-01-09" }] },
    });
    const { product, match } = await findBestProductMatch(client(mock), CHARIZARD_4);
    expect(product).toBeNull();
    expect(match.conflicts.some((c) => /mismatch/i.test(c))).toBe(true);
  });

  it("returns Unresolved when nothing matches", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: [] } });
    const { product, match } = await findBestProductMatch(client(mock), CHARIZARD_4);
    expect(product).toBeNull();
    expect(match.confidence_level).toBe("Unresolved");
  });

  it("uses an explicit PriceCharting id directly", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: { id: "6910", "product-name": "Charizard #4", "console-name": "Pokemon Base Set" } });
    const { product, match } = await findBestProductMatch(client(mock), { ...CHARIZARD_4, pricecharting_id: "6910" });
    expect(product?.pricecharting_id).toBe("6910");
    expect(match.confidence_score).toBeGreaterThanOrEqual(95);
  });
});

describe("valuation refuses low-confidence matches", () => {
  it("returns AMBIGUOUS_PRODUCT instead of guessing a value", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", {
      json: {
        products: [
          { id: "1", "product-name": "Charizard #4", "console-name": "Pokemon Base Set", "release-date": "1999-01-09", "loose-price": 3500 },
          { id: "2", "product-name": "Charizard #4", "console-name": "Pokemon Base Set", "release-date": "1999-01-09", "loose-price": 9900 },
        ],
      },
    });
    const r = await getCardValuation(client(mock), CHARIZARD_4);
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error_code).toBe("AMBIGUOUS_PRODUCT");
      expect(Array.isArray((r.details as { candidates?: unknown[] }).candidates)).toBe(true);
    }
  });
});
