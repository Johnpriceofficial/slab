# Running the benchmark against a TEST Supabase project

The benchmark calls the **deployed** `analyze-slab` Edge Function to get real
model readings. It **hard-refuses the production project** (`rcbwemkfcefarqnlgrmv`,
by ref or URL). So a real run needs a dedicated, non-production project that runs
the same function. This is a one-time setup.

Nothing here should be run against production. The harness enforces that, but so
should you.

## 1. Create a test project

In the Supabase dashboard, create a new project (any region), e.g.
`gradedcardvalue-benchmark`. Note its **project ref** (the `xxxx` in
`https://xxxx.supabase.co`) — it must NOT be `rcbwemkfcefarqnlgrmv`.

## 2. Apply the schema

From the repo root, link the CLI to the test project and push migrations so the
function's tables/RPCs exist:

```bash
supabase link --project-ref <TEST_REF>
supabase db push          # applies supabase/migrations to the TEST project
```

## 3. Set the function secrets

`analyze-slab` reads these at runtime (verified against its source):

| Secret | Required? | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | **Yes** | The vision model key. Without it the function errors. |
| `OPENAI_ANALYZE_MODEL` | Optional | Overrides the default analyze model. |
| `ANALYZE_DAILY_LIMIT` | Optional | Per-day call cap; raise/disable for a big run. |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform — you
do not set those yourself.

```bash
supabase secrets set OPENAI_API_KEY="sk-..." --project-ref <TEST_REF>
# optional:
supabase secrets set ANALYZE_DAILY_LIMIT="100000" --project-ref <TEST_REF>
```

> Set secrets via the Supabase CLI/dashboard yourself — do not paste keys into
> chat or commit them.

## 4. Deploy the function

```bash
supabase functions deploy analyze-slab --project-ref <TEST_REF>
```

Confirm it's ACTIVE in the dashboard's Edge Functions list.

## 5. Get the URL + anon key

From the dashboard (Project Settings → API), copy the project URL
(`https://<TEST_REF>.supabase.co`) and the **anon** (public) key.

## 6. Run

```bash
SLABVAULT_BENCH_URL="https://<TEST_REF>.supabase.co" \
SLABVAULT_BENCH_ANON_KEY="<test anon key>" \
bun scripts/benchmark/run.ts \
  --manifest benchmark-data/manifest.csv \
  --out benchmark-results \
  --concurrency 2 --delay 350
```

It resolves images relative to the manifest, calls `analyze-slab` per sample
(bounded concurrency, retry, resume), scores against ground truth, and writes the
report bundle to `benchmark-results/` (`summary.md`, `summary.json`,
`per-sample.csv`, `failures.csv`, `confident-cert-errors.csv`, `raw-responses/`).
It exits non-zero if any gate fails.

### Also scoring the PriceCharting product match (`--match`)

To additionally measure product-match accuracy (feeds the model's predicted
identity into the production matcher), add `--match` and provide a PriceCharting
token **in the local shell** (the matcher runs in the CLI, not the edge function):

```bash
PRICECHARTING_API_TOKEN="<token>" \
SLABVAULT_BENCH_URL="https://<TEST_REF>.supabase.co" \
SLABVAULT_BENCH_ANON_KEY="<test anon key>" \
bun scripts/benchmark/run.ts \
  --manifest benchmark-data/manifest.csv \
  --out benchmark-results \
  --match
```

Only rows whose manifest has a verified `pricecharting_product_id` are judged for
match accuracy; the rest are reported as unjudgeable. The report then includes a
**PriceCharting product match** section (accuracy, and the confidently-wrong-match
count that is a hard failure).

## Thresholds (flags; defaults shown)

| Flag | Default | Gate |
| --- | --- | --- |
| `--min-identity` | 0.99 | card identity accuracy ≥ |
| `--min-grade` | 0.995 | grade accuracy ≥ |
| `--min-cert` | 0.999 | certification accuracy ≥ |
| `--max-confident-cert-errors` | 0 | confidently-wrong certs ≤ (any is a hard fail) |
| `--max-manual-review` | 0.05 | manual-review rate ≤ |
| `--min-match` | 0.95 | PriceCharting match accuracy ≥ (only when measured) |
| `--max-confident-match-errors` | 0 | confidently-wrong matches ≤ (only when measured) |
| `--acceptance-threshold` | 0.7 | confidence at/above which a wrong value is "confident" |

## Cost / safety notes

- Every sample is one real vision-model call. Start with a small pilot manifest to
  estimate cost before a full run.
- The run is interrupt-safe: completed samples are cached in
  `benchmark-results/.state/` and skipped on re-run. Delete `.state/` to force a
  clean re-run.
- Keep the test project's keys out of the repo. `benchmark-data/` (images +
  filled manifest) is yours to keep local; do not commit real card images unless
  you intend to.
