import { describe, expect, it } from "vitest";
import { buildProductPageUrl, extractCatalogImage } from "@/lib/pricecharting/catalog-image";
import type { Product } from "@/lib/pricecharting/types";

const product: Product = {
  pricecharting_id: "11302479",
  name: "N's Zoroark ex #112",
  console_or_category: "Pokemon Japanese Mega Dream ex",
  release_date: null,
  upc: null,
  asin: null,
  epid: null,
  genre: null,
  raw_prices: {},
};

describe("PriceCharting public-page catalog image fallback", () => {
  it("constructs the canonical product page from API identity fields", () => {
    expect(buildProductPageUrl(product)).toBe(
      "https://www.pricecharting.com/game/pokemon-japanese-mega-dream-ex/n%27s-zoroark-ex-112",
    );
  });

  it("extracts the catalog image and ignores unrelated sale thumbnails", () => {
    const html = `
      <img class="sale-image" src="https://www.pricecharting.com/sale.jpg">
      <meta property="og:image" content="https://storage.googleapis.com/images.pricecharting.com/catalog/240.jpg">
    `;
    expect(extractCatalogImage(html)).toBe(
      "https://storage.googleapis.com/images.pricecharting.com/catalog/240.jpg",
    );
  });

  it("rejects images from untrusted hosts", () => {
    expect(extractCatalogImage('<meta property="og:image" content="https://evil.example/card.jpg">')).toBeNull();
  });
});
