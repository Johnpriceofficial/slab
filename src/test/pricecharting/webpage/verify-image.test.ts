import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProductPage } from "@/lib/pricecharting/webpage/parse";
import { verifyPageIdentity } from "@/lib/pricecharting/webpage/verify";
import { extractArtwork } from "@/lib/pricecharting/webpage/image";

const fixture = (name: string) => readFileSync(join(process.cwd(), "src/test/fixtures/pricecharting", name), "utf8");
const RAYQUAZA = parseProductPage(fixture("rayquaza-full-prices.html"));
const WRONG = parseProductPage(fixture("wrong-product.html"));
const CHALLENGE = parseProductPage(fixture("challenge-page.html"));

const LINKED = { product_id: "3472875", card_number: "047/067", language: "Japanese", canonical_url: "https://www.pricecharting.com/game/pokemon-japanese-blue-sky-stream/rayquaza-vmax-47" };

describe("PriceCharting public page — identity verification", () => {
  it("(1) verifies the exact product identity", () => {
    const v = verifyPageIdentity(RAYQUAZA, LINKED);
    expect(v.status).toBe("VERIFIED");
  });

  it("(2) rejects a wrong product id", () => {
    const v = verifyPageIdentity(WRONG, LINKED); // page is product 6910
    expect(v.status).toBe("REJECTED");
    expect(v.reasons.join()).toMatch(/product id/i);
  });

  it("(3) rejects a wrong card number", () => {
    const v = verifyPageIdentity(RAYQUAZA, { ...LINKED, product_id: "3472875", card_number: "001/067" });
    expect(v.status).toBe("REJECTED");
    expect(v.reasons.join()).toMatch(/card number/i);
  });

  it("(4) rejects a language/region conflict", () => {
    const v = verifyPageIdentity(RAYQUAZA, { ...LINKED, language: "English" }); // page is Japanese
    expect(v.status).toBe("REJECTED");
    expect(v.reasons.join()).toMatch(/language/i);
  });

  it("(5) rejects a challenge / non-product page", () => {
    const v = verifyPageIdentity(CHALLENGE, LINKED);
    expect(v.status).toBe("REJECTED");
  });

  it("does not accept a similar page on title alone — requires id/number agreement", () => {
    // Same title words but different id → still rejected.
    const v = verifyPageIdentity(WRONG, { product_id: "6910", card_number: "999/999" });
    expect(v.status).toBe("REJECTED");
  });
});

describe("PriceCharting public page — reference artwork", () => {
  it("(12) extracts the official product artwork from the trusted storage host", () => {
    const art = extractArtwork(RAYQUAZA);
    expect(art).not.toBeNull();
    expect(art!.image_url).toMatch(/^https:\/\/storage\.googleapis\.com\/images\.pricecharting\.com\//);
    expect(art!.is_reference_artwork).toBe(true);
  });

  it("(13) rejects site logos, set logos, seller images, and untrusted hosts", () => {
    const reject = (image_url: string | null) => extractArtwork({ ...RAYQUAZA, image_url });
    expect(reject("https://www.pricecharting.com/images/logo-cgc.gif")).toBeNull();
    expect(reject("https://www.pricecharting.com/images/pokemon-sets/set.png")).toBeNull();
    expect(reject("https://i.ebayimg.com/seller/thumb.jpg")).toBeNull();
    expect(reject("https://storage.googleapis.com/images.pricecharting.com/logo/logo.png")).toBeNull();
    expect(reject("http://storage.googleapis.com/images.pricecharting.com/x/240.jpg")).toBeNull(); // not https
    expect(reject(null)).toBeNull();
  });
});
