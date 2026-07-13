import { describe, expect, it } from "vitest";
import { buildProductPageUrl, extractCatalogImage, extractPublicGuidePrice } from "@/lib/pricecharting/catalog-image";
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

  it("extracts PriceCharting's live Main Image markup when social metadata is absent", () => {
    const html = '<img alt="Main Image | Charizard [Incorrect Holo Error] Pokemon Japanese VMAX Climax" src="https://storage.googleapis.com/images.pricecharting.com/catalog/charizard/240.jpg">';
    expect(extractCatalogImage(html)).toBe(
      "https://storage.googleapis.com/images.pricecharting.com/catalog/charizard/240.jpg",
    );
  });

  it("rejects images from untrusted hosts", () => {
    expect(extractCatalogImage('<meta property="og:image" content="https://evil.example/card.jpg">')).toBeNull();
  });

  it("extracts a compatible Grade 9 guide and an exact CGC Pristine guide", () => {
    const html = `<section><h2>Full Price Guide</h2>
      Grade 9 $16.01 Grade 9.5 $18.00 CGC 10 $20.50 PSA 10 $47.04 CGC 10 Pristine $24.99
    </section>`;
    expect(extractPublicGuidePrice(html, "CGC", 9, "MINT")).toMatchObject({
      value_cents: 1601, field: "graded-price", tier_key: "grade_9_general", designation_exact: false,
    });
    expect(extractPublicGuidePrice(html, "CGC", 10, "PRISTINE")).toMatchObject({
      value_cents: 2499, field: "public-cgc-10-pristine", tier_key: "cgc_10_pristine", designation_exact: true,
    });
  });
});
