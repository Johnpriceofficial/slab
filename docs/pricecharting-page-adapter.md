# PriceCharting public product-page adapter

A **server-side, feature-flagged** second evidence source that reads the public
PriceCharting product page to recover graded grade-tier values and reference
artwork **when the official PriceCharting API omits them** (as it does for many
Japanese cards — e.g. product `3472875`, where the API returns only
`loose-price` but the public page shows CGC 10 Pristine `$45.39`).

It is a **distinct source** (`PRICECHARTING_PUBLIC_PAGE`), never labeled as the
API, never a completed sale, and it never uses the slab certification number.

## Status: DISABLED by default — Terms/operational review PENDING

`PRICECHARTING_PAGE_ADAPTER_ENABLED=false` by default. With the flag off the
adapter performs **no network fetch of any kind** (`getProductPageSnapshot`
returns state `disabled`). It must stay off in production until the review below
is completed and signed off by an operator.

### Operator review checklist (complete before enabling)

- [ ] **Terms of Service** — review PriceCharting's ToS for automated access to
      public product pages; confirm this adapter does not violate them.
- [ ] **Access restrictions** — confirm the adapter does not bypass
      authentication, paywalls, CAPTCHA, or anti-bot protections (it does not —
      a block returns `provider_blocked` and is never evaded).
- [ ] **robots.txt** — PriceCharting's `robots.txt` does not broadly disallow
      `/game/` product pages, but confirm current state at review time.
      (robots.txt is not, by itself, permission or a substitute for the ToS.)
- [ ] **Rate/impact** — confirm the ≤1 req/s limit + 24h cache + circuit breaker
      are acceptable operationally.
- [ ] **Sign-off** — record the reviewer, date, and outcome here, then set
      `PRICECHARTING_PAGE_ADAPTER_ENABLED=true` as an edge-function secret.

> This checklist is a legal/operational gate. Engineering built the adapter
> disabled-by-default; the decision to enable it in production is the operator's.

## Design summary

- **Source:** the confirmed canonical `/game/<console>/<slug>` product page only.
  URL is validated (HTTPS, exact host allowlist, `/game/` path, no private IPs,
  no credentials); redirects are revalidated with the same rules.
- **Fetch (server-only):** honest stable User-Agent, response-size + timeout
  caps, one retry on transient 5xx/network only, no retry on 4xx, `429`/
  `Retry-After` respected, ≤1 req/s reservation, in-memory circuit breaker. No
  headless browser, no page-JS execution, no proxy/UA rotation, no anti-bot
  evasion. A block ⇒ `provider_blocked`.
- **Parse (pure, fixture-tested):** a real HTML parser (**linkedom**, works in
  Node + Deno) selects the `#full-prices` table and its rows/cells STRUCTURALLY
  by DOM (the price cell is chosen by `td.price`, not column position), so minor
  whitespace/formatting changes don't break extraction. Identity anchors come
  from `h1#product_name[title=<id>]`, `data-product-id`, and the canonical link.
  Non-product pages (search/error/challenge/login) are detected and rejected.
- **API-FIRST, page-on-gap:** the page is a FALLBACK. `valueGradedTierApiFirst`
  uses the official API value when it has the exact tier and **never fetches the
  page**; it consults (and only then fetches) the public page ONLY when the API
  lacks the tier. This minimizes requests and stays on the official API whenever
  possible.
- **Complete snapshot:** one fetch captures EVERY grade shown (Ungraded → ACE 10),
  stored as the normalized snapshot (`snapshotTierMap` → `{tier: cents}`), so the
  UI can populate Compare-Other-Grades, Market Intelligence, upgrade/downgrade,
  and insurance values without re-fetching.
- **Verify:** product id is the primary key; card number + language + canonical
  URL corroborate. A conflict ⇒ `REJECTED`. Never accepted on title alone.
- **Normalize:** page labels → the app's canonical tiers, every grade-10 variant
  kept distinct; `$` values → integer cents; `-`/malformed/implausible ⇒ null
  (never 0, never fabricated).
- **Artwork:** only the product image on `storage.googleapis.com/
  images.pricecharting.com/…`; grader/set logos, ads, and seller images rejected.
  Labeled "PriceCharting reference artwork" — never the user's slab photo.
- **Identity-driven, never specimen-driven:** search, page URL, cache, valuation,
  scraping, and artwork are driven ONLY by the canonical card identity (name, set,
  number, language, variant) and the catalog product it resolves to. The
  certification number, grader, submission id, owner, and inventory record never
  influence any of these — cert exists only for verification + inventory.
- **Cache:** two equivalent keys, both cert/grader/owner-free, so every specimen
  of a card shares one snapshot: `pageCacheKey` (product id + canonical URL +
  parser/source version) and `identityCacheKey` (a canonical-identity slug like
  `pokemon|japanese|blue-sky-stream|047-067|rayquaza-vmax`, usable before a
  product id resolves). 24h success TTL; short negative TTL for blocked/rate-
  limited/parse failures.
- **Generic provider interface:** the snapshot carries a `provider_id` and the
  code defines a `MarketPageProvider` contract (id, host allowlist, safeProductUrl,
  parse, verify) so PriceCharting is the FIRST of several providers (Card Ladder,
  Alt, Goldin, PWCC) behind one shape — each identity-verified with its own
  provenance. The snapshot also captures product title, canonical URL, market
  artwork, `last_updated_text` (null when absent), and every visible tier
  (unavailable = null) so future UI needs no re-scrape.
- **Valuation priority:** exact API tier → exact verified public-page tier →
  verified completed sales → compatible → unavailable. Agreement corroborates
  (not double-counted); a material conflict is surfaced and lowers confidence —
  the higher value is never auto-picked. A graded slab never falls back to
  loose-price; the public-page value is a current guide/reference value, never a
  completed sale.
- **Security:** SSRF-guarded URL construction; no cookies/session/PII stored; no
  raw HTML, headers, tokens, or stack traces returned to the client.

## Not yet wired (the "enable" step)

This PR delivers the complete, tested adapter library (flag off). Wiring it into
an edge-function orchestration action and the linked-product UI panel is the
enablement step, to be done together with flipping the flag on **after** the
review above — so the deployed functions are unchanged while the flag is off.

## Roadmap: one provider in a broader market engine

The public-page adapter is deliberately shaped as ONE provider behind the
Identity Engine, not a PriceCharting-specific hack. The long-term valuation
pipeline is:

```
Identity Engine → PriceCharting API → PriceCharting Public Page → eBay Sold →
Card Ladder → Alt → Goldin → PWCC → Historical Internal Sales → Population Reports
→ Valuation Engine
```

Each source is verified against the canonical card identity (never the cert),
attaches its own provenance, and is combined by the same priority/corroboration/
conflict rules used here. That multi-provider engine is future work, not this PR.
