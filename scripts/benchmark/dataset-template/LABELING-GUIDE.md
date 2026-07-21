# Benchmark dataset — labeling guide

This is how to build the labeled dataset the accuracy benchmark scores against.
Every number the benchmark reports is only as trustworthy as this ground truth,
so the guiding rule is: **label what the card actually is, and leave a field
BLANK whenever the true value is genuinely unknown or absent — never guess.**

A blank field is not a failure. The harness treats an absent ground-truth value
as "not evaluable" (excluded from that field's accuracy). Guessing a value you
can't actually confirm corrupts the benchmark far more than a blank does.

## Files

- `manifest.template.csv` — copy it, delete the two `EXAMPLE-*` rows, add your own.
- Put images anywhere; paths in the manifest are resolved **relative to the
  manifest file** (or use absolute paths). Both `.jpg/.png/.webp/.heic` work.

Save your filled copy somewhere outside this template dir, e.g.
`benchmark-data/manifest.csv` with images under `benchmark-data/images/`.

## Columns

### Required (must be non-empty on every row)

| Column | Meaning |
| --- | --- |
| `sample_id` | Unique id for the row. Stable — results and resume state key off it. |
| `front_image_path` | Path to the front image. |
| `card_name` | The card's character/player/name as printed. |
| `set_name` | The set/series name. |
| `card_number` | The printed collector number, verbatim (`4/102`, `016/064`, `SV107`, `289/S-P`). |
| `language` | `English`, `Japanese`, `Chinese`, etc. |

`card_name + set_name + card_number + language` are the four **identity** fields —
their exact agreement defines a correct card identity. Get these right above all.

### Slab-only (fill for graded slabs; leave BLANK for raw cards)

| Column | Meaning |
| --- | --- |
| `grader` | `PSA`, `BGS`, `CGC`, `SGC`, … |
| `grade` | Numeric grade, e.g. `10`, `9.5`. Compared numerically (`10` ≡ `10.0`). |
| `grade_label` | Designation if any: `GEM MINT`, `PRISTINE`, `BLACK LABEL`. |
| `certification_number` | The cert/serial on the label, digits/letters only. |

**Raw cards leave all four blank.** The manifest parser allows this on purpose;
a raw row simply isn't scored on grade/cert. Do NOT invent a grader/grade for a
raw card.

### Optional identity / descriptor

| Column | Meaning |
| --- | --- |
| `back_image_path` | Back image, if captured. Front-only rows leave it blank. |
| `year` | Print year. Captured for reference; **not currently scored** (the deployed analyze-slab does not emit year yet). Fill it anyway — it's cheap and future-proofs the dataset. |
| `variation` | Full variant string as you'd describe it (`Reverse Holo`, `1st Edition`, `Alt Art`, a parallel name). |
| `finish` | Surface finish (`Holo`, `Reverse Holo`, `Non-Holo`). May duplicate part of `variation`. |
| `rarity` | Printed rarity. |
| `pricecharting_product_id` | The expected PriceCharting product id, **only when you have verified it** (see below). Blank ⇒ the product match is "unjudgeable" for this row, never scored wrong. |

### Capture-condition columns (drive the by-quality / by-type breakdowns)

`label_color`, `lighting_condition` (`studio`/`ambient`/`low`), `orientation`
(`vertical`/`horizontal`), `glare` (`none`/`slight`/`heavy`), `blur`
(`none`/`slight`/`heavy`), `crop_quality` (`tight`/`loose`/`skewed`).

These aren't scored — they're how the report slices accuracy ("identity accuracy
on `blur=heavy` rows"). Label them honestly from the image; leave blank if unsure
(shows as `unspecified`). **To measure "performance by image quality" you must
deliberately include low-quality captures** — an all-clean dataset can't tell you
how the model degrades.

## The `pricecharting_product_id` column (product-match truth)

This is the truth for the PriceCharting match dimension. Only fill it when you've
**verified** the product id points at the exact same card (right set, number,
language, and — for graded value — grade tier). To find it: search the card on
pricecharting.com and take the numeric id from the product URL, or use the app's
own confirmed match if a human has verified it. When in doubt, leave it blank —
an unverified id would make the match benchmark measure your labeling error, not
the pipeline.

## Hard / ambiguous examples

Use the `notes` column to record anything that makes a row genuinely hard, and
**deliberately include such rows** — they're where accuracy actually gets tested:

- **Near-duplicate numbers** — cards that share every identifier except the
  collector number (alt-art/parallel prints). Note it; number precision is the
  whole point here.
- **Unmarked language** — an English card is often the "unmarked" default on
  PriceCharting. If a card is Japanese/Chinese, label `language` exactly; the
  matcher is designed not to auto-confirm a non-English card onto an unmarked
  (English) product.
- **Promo suffixes** — `289/S-P` vs `289/SV-P` are different cards. Record the
  full printed number including the suffix.
- **Glare over the cert / grade** — if a label field is unreadable in the image,
  still label the TRUE value from the physical card; the benchmark then measures
  whether the model correctly abstained vs guessed.
- **Reprints / multiple years** — if two print years exist, label the actual one.

## Sanity check before running

- Every `sample_id` unique; every `front_image_path` exists.
- Identity fields filled on every row.
- Slab rows have grader+grade; raw rows leave them blank.
- `pricecharting_product_id` filled only where verified.
- A spread of capture qualities and both raw + slab present.

Then run per `../README.md` (dry-run to sanity-check plumbing, then a real run
against a TEST project — never production).
