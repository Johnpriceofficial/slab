# analyze-slab accuracy benchmark

Measures the real accuracy of the deployed `analyze-slab` Edge Function against a
labeled slab dataset. Green CI proves the deterministic reconciliation logic; this
harness is what proves the **model's OCR** is good enough to rely on.

The logic lives in `src/lib/benchmark/` (pure, typechecked, unit-tested). This
directory holds only the Node/Bun CLI that wires it to real I/O.

## Dataset manifest

CSV or JSON. Required columns (must be non-empty): `sample_id`,
`front_image_path`, `grader`, `grade`, `card_name`, `set_name`, `card_number`,
`language`. Also read when present: `back_image_path` (may be blank),
`grade_label`, `certification_number`, `rarity`, `finish`, `variation`,
`label_color`, `lighting_condition`, `orientation`, `notes`, and the optional
capture-quality columns `glare`, `blur`, `crop_quality`.

Image paths are resolved relative to the manifest file.

## Running against a TEST project

The harness **refuses to run against the production project** (`rcbwemkfcefarqnlgrmv`),
by ref or URL. Point it at a dedicated test project:

```bash
SLABVAULT_BENCH_URL="https://<TEST_REF>.supabase.co" \
SLABVAULT_BENCH_ANON_KEY="<test anon key>" \
bun scripts/benchmark/run.ts \
  --manifest path/to/dataset.csv \
  --out benchmark-results \
  --concurrency 2 --delay 350
```

Interrupt-safe: completed samples are written to `benchmark-results/.state/` and
skipped on the next run. Re-run the same command to resume.

### Thresholds (defaults; override with flags)

| Flag | Default |
| --- | --- |
| `--min-identity` | 0.99 |
| `--min-grade` | 0.995 |
| `--min-cert` | 0.999 |
| `--max-confident-cert-errors` | 0 |
| `--max-manual-review` | 0.05 |
| `--acceptance-threshold` | 0.7 |

The command exits non-zero if any gate fails — and **a single confidently-incorrect
certification is always a hard failure**.

## Dry run (no OpenAI — what CI exercises)

```bash
bun run benchmark:dry-run
```

Uses `fixtures/manifest.csv` + `fixtures/responses.json` to drive the entire
pipeline deterministically, with no network and no key.

## Outputs (`benchmark-results/`)

- `summary.json` — full metrics, thresholds, breakdowns
- `summary.md` — compact pass/fail + worst-performing categories
- `per-sample.csv` — every field's predicted/truth/match/confidence
- `failures.csv` — samples needing manual correction
- `confident-cert-errors.csv` — the hard-failure list (should be empty)
- `raw-responses/` — the untouched model response for every sample
