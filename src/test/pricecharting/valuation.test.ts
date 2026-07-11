import { describe, it, expect } from "vitest";
import { PriceChartingClient } from "@/lib/pricecharting/client";
import {
  getCardValuation,
  getVideoGameValuation,
  getComicValuation,
  getCoinValuation,
  getValuesForAllConditions,
} from "@/lib/pricecharting/valuation";
import { nullLogger } from "@/lib/pricecharting/logger";
import type { ValuationResult } from "@/lib/pricecharting/types";
import { createMockFetch, RecordingClock } from "./helpers";

function client(mock: ReturnType<typeof createMockFetch>) {
  return new PriceChartingClient({
    fetch: mock.fetchImpl,
    clock: new RecordingClock(),
    logger: nullLogger,
    tokenProvider: () => "tok-abcdefghijklmnop",
  });
}

const CARD = {
  id: "6910",
  "product-name": "Charizard #4",
  "console-name": "Pokemon Base Set",
  "release-date": "1999-01-09",
  "loose-price": 3500, // ungraded
  "cib-price": 4800, // grade 7 / 7.5
  "new-price": 6500, // grade 8 / 8.5
  "graded-price": 12500, // GENERAL grade 9
  "box-only-price": 22500, // grade 9.5
  "manual-only-price": 50000, // PSA 10
  "bgs-10-price": 60000, // BGS 10
  "condition-17-price": 42500, // CGC 10
  // condition-18-price (SGC 10) intentionally ABSENT
};

function cardClient() {
  const mock = createMockFetch();
  mock.enqueue("/api/product?", { json: CARD });
  return client(mock);
}

function ok(r: unknown): ValuationResult {
  expect((r as { status?: string }).status).toBe("success");
  return r as ValuationResult;
}

describe("card valuation — grade mapping", () => {
  it("ungraded uses loose-price", async () => {
    const r = ok(
      await getCardValuation(cardClient(), {
        category: "trading_card",
        pricecharting_id: "6910",
        card_name: "Charizard",
        card_number: "4",
      }),
    );
    expect(r.valuation.field_used).toBe("loose-price");
    expect(r.valuation.requested_value_dollars).toBe(35);
  });

  it("PSA 9 uses graded-price and is labeled GENERAL grade 9, not company-specific", async () => {
    const r = ok(
      await getCardValuation(cardClient(), {
        category: "trading_card",
        pricecharting_id: "6910",
        grading_company: "PSA",
        grade: 9,
      }),
    );
    expect(r.valuation.field_used).toBe("graded-price");
    expect(r.valuation.requested_value_dollars).toBe(125);
    expect(r.valuation.company_specific).toBe(false);
    expect(r.warnings.some((w) => /general Grade 9/i.test(w))).toBe(true);
    // Always labeled a current estimate, not an eBay last-sold.
    expect(r.is_ebay_last_sold).toBe(false);
    expect(r.warnings.some((w) => /not a verified eBay last-sold/i.test(w))).toBe(true);
  });

  it("PSA 10 uses manual-only-price and IS company-specific", async () => {
    const r = ok(
      await getCardValuation(cardClient(), {
        category: "trading_card",
        pricecharting_id: "6910",
        grading_company: "PSA",
        grade: 10,
      }),
    );
    expect(r.valuation.field_used).toBe("manual-only-price");
    expect(r.valuation.requested_value_dollars).toBe(500);
    expect(r.valuation.company_specific).toBe(true);
  });

  it("BGS 10 uses bgs-10-price", async () => {
    const r = ok(
      await getCardValuation(cardClient(), {
        category: "trading_card",
        pricecharting_id: "6910",
        grading_company: "BGS",
        grade: 10,
      }),
    );
    expect(r.valuation.field_used).toBe("bgs-10-price");
    expect(r.valuation.requested_value_dollars).toBe(600);
  });

  it("CGC 10 uses condition-17-price", async () => {
    const r = ok(
      await getCardValuation(cardClient(), {
        category: "trading_card",
        pricecharting_id: "6910",
        grading_company: "CGC",
        grade: 10,
      }),
    );
    expect(r.valuation.field_used).toBe("condition-17-price");
    expect(r.valuation.requested_value_dollars).toBe(425);
  });

  it("SGC 10 returns null (field absent) and NEVER substitutes PSA 10", async () => {
    const r = ok(
      await getCardValuation(cardClient(), {
        category: "trading_card",
        pricecharting_id: "6910",
        grading_company: "SGC",
        grade: 10,
      }),
    );
    expect(r.valuation.requested_value_pennies).toBeNull();
    expect(r.valuation.field_used).toBeNull();
    // The PSA 10 value is available but must not leak into the SGC request.
    expect(r.valuation.available_values.psa_10).toBe(500);
    expect(r.valuation.available_values.sgc_10).toBeNull();
  });

  it("an unsupported grade returns null with an explanatory warning", async () => {
    const r = ok(
      await getCardValuation(cardClient(), {
        category: "trading_card",
        pricecharting_id: "6910",
        grading_company: "PSA",
        grade: 6,
      }),
    );
    expect(r.valuation.requested_value_pennies).toBeNull();
    expect(r.warnings.some((w) => /does not provide a direct value for grade 6/i.test(w))).toBe(true);
  });

  it("multiplies by quantity for the extended value", async () => {
    const r = ok(
      await getCardValuation(cardClient(), {
        category: "trading_card",
        pricecharting_id: "6910",
        grading_company: "PSA",
        grade: 10,
        quantity: 3,
      }),
    );
    expect(r.quantity).toBe(3);
    expect(r.extended_value_dollars).toBe(1500);
  });
});

describe("video game valuation — condition mapping", () => {
  const GAME = {
    id: "100",
    "product-name": "EarthBound",
    "console-name": "Super Nintendo",
    "loose-price": 20000,
    "cib-price": 30000,
    "new-price": 90000,
    "graded-price": 120000,
  };
  function gameClient() {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: GAME });
    return client(mock);
  }

  it("loose uses loose-price", async () => {
    const r = ok(await getVideoGameValuation(gameClient(), { category: "video_game", pricecharting_id: "100", condition: "loose" }));
    expect(r.valuation.field_used).toBe("loose-price");
    expect(r.valuation.requested_value_dollars).toBe(200);
  });
  it("CIB uses cib-price", async () => {
    const r = ok(await getVideoGameValuation(gameClient(), { category: "video_game", pricecharting_id: "100", condition: "cib" }));
    expect(r.valuation.field_used).toBe("cib-price");
    expect(r.valuation.requested_value_dollars).toBe(300);
  });
  it("sealed/new uses new-price", async () => {
    const r = ok(await getVideoGameValuation(gameClient(), { category: "video_game", pricecharting_id: "100", condition: "sealed" }));
    expect(r.valuation.field_used).toBe("new-price");
    expect(r.valuation.requested_value_dollars).toBe(900);
  });
});

describe("comic valuation — grade mapping", () => {
  const COMIC = {
    id: "200",
    "product-name": "Amazing Spider-Man #300",
    "console-name": "Comic Books",
    "loose-price": 5000,
    "cib-price": 8000,
    "new-price": 15000,
    "graded-price": 40000,
    "box-only-price": 90000,
    "condition-17-price": 120000,
    "manual-only-price": 250000,
    "bgs-10-price": 500000,
  };
  function comicClient() {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: COMIC });
    return client(mock);
  }

  it("grade 9.8 uses manual-only-price", async () => {
    const r = ok(await getComicValuation(comicClient(), { category: "comic", pricecharting_id: "200", grade: 9.8 }));
    expect(r.valuation.field_used).toBe("manual-only-price");
    expect(r.valuation.requested_value_dollars).toBe(2500);
  });
  it("grade 10.0 uses bgs-10-price", async () => {
    const r = ok(await getComicValuation(comicClient(), { category: "comic", pricecharting_id: "200", grade: 10 }));
    expect(r.valuation.field_used).toBe("bgs-10-price");
    expect(r.valuation.requested_value_dollars).toBe(5000);
  });
});

describe("coin valuation — no card/comic mapping is applied", () => {
  it("returns null for the requested grade with a coin-specific warning", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: { id: "300", "product-name": "1909-S VDB Lincoln Cent", "console-name": "Coins", "loose-price": 120000 } });
    const r = ok(
      await getCoinValuation(client(mock), { category: "coin", pricecharting_id: "300", grading_company: "PSA", grade: 65 }),
    );
    expect(r.valuation.requested_value_pennies).toBeNull();
    expect(r.warnings.some((w) => /No documented PriceCharting grade mapping/i.test(w))).toBe(true);
  });
});

describe("getValuesForAllConditions", () => {
  it("returns the full labeled value map for a card", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: CARD });
    const r = await getValuesForAllConditions(client(mock), "6910", "card");
    expect("values" in r).toBe(true);
    if ("values" in r) {
      expect(r.values.ungraded).toBe(35);
      expect(r.values.grade_9_general).toBe(125);
      expect(r.values.psa_10).toBe(500);
      expect(r.values.sgc_10).toBeNull();
    }
  });
});
