# GradedCardValue.com — data layer

The full GradedCardValue.com documentation lives in the repository root: [`../../../SLABVAULT.md`](../../../SLABVAULT.md).

This directory (`src/lib/slabs/`) holds the framework-agnostic data layer:

- `types.ts` — domain types (money is integer cents; certs are text).
- `constants.ts` — enums, column orders, `normalizeImageExt`.
- `normalize.ts` — cert/grader normalization (parity with the SQL functions).
- `format.ts` — money/date formatting helpers.
- `compute-stats.ts` — dashboard statistics.
- `comps.ts` — sold-comp statistics + Final Value suggestion.
- `save-slab.ts` — dependency-injected, unit-testable save flow.
- `data.ts` — Supabase-backed queries, RPCs, storage, and edge-function calls.
- `excel.ts` — 3-sheet workbook export.
