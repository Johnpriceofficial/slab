# Supporting indexes for foreign keys (G6)

**Terminology:** these are **supporting indexes for foreign keys** — plain btree
indexes on the FK column so the FK is not left unindexed. They are **not "covering"
indexes**: a covering index adds `INCLUDE` columns to satisfy a query from the index
alone, which none of these do.

**Scope:** performance only — no authorization or behaviour change. The Supabase
performance advisor reports **28** unindexed foreign keys. This PR adds **17** on the
active customer / pricing / analysis path and **defers 11** on dormant, empty feature
tables. Migration `20260911000000_supporting_fk_indexes.sql`. Draft — not applied to
any environment; depends on the F4 ledger reconciliation.

## Why index an FK column
An FK with no supporting index forces (a) a sequential scan of the child table whenever
a referenced parent row is deleted (e.g. deleting an `auth.users` row checks every child
FK), and (b) slower joins/filters on that column. On a growing table this becomes a real
cost; on an empty/dormant table it is premature.

## Added now (17) — justified

| Index | Table.column | Use case |
|---|---|---|
| `audit_log_owner_id_idx` | `audit_log.owner_id` | owner-scoped RLS read (`owner_id = auth.uid()`); user-deletion |
| `audit_log_actor_user_id_idx` | `audit_log.actor_user_id` | user-deletion; actor lookups |
| `valuation_snapshots_owner_id_idx` | `valuation_snapshots.owner_id` | owner-scoped reads; user-deletion |
| `valuation_snapshots_pricecharting_product_id_idx` | `valuation_snapshots.pricecharting_product_id` | pricing-evidence join → `pricecharting_products` |
| `slab_images_created_by_idx` | `slab_images.created_by` | per-owner image reads; user-deletion |
| `slabs_visual_confirmation_by_idx` | `slabs.visual_confirmation_by` | user-deletion on the core table |
| `slab_pricecharting_events_created_by_idx` | `slab_pricecharting_events.created_by` | user-deletion; event history |
| `slab_product_links_confirmed_by_idx` | `slab_product_links.confirmed_by` | user-deletion; confirmation lookups |
| `slab_product_links_pricecharting_product_id_idx` | `slab_product_links.pricecharting_product_id` | pricing join |
| `slab_product_candidates_pricecharting_product_id_idx` | `slab_product_candidates.pricecharting_product_id` | pricing candidate join |
| `card_scan_reviews_resolved_by_idx` | `card_scan_reviews.resolved_by` | reviewer lookups; user-deletion |
| `pricecharting_offer_events_offer_id_idx` | `pricecharting_offer_events.offer_id` | offer-event history join |
| `pricecharting_offer_events_actor_user_id_idx` | `pricecharting_offer_events.actor_user_id` | user-deletion; audit |
| `pricecharting_offers_created_by_idx` | `pricecharting_offers.created_by` | user-deletion; audit |
| `pricecharting_offers_updated_by_idx` | `pricecharting_offers.updated_by` | user-deletion; audit |
| `pricecharting_sync_runs_created_by_idx` | `pricecharting_sync_runs.created_by` | user-deletion; run history |
| `pricecharting_marketplace_settings_updated_by_idx` | `pricecharting_marketplace_settings.updated_by` | user-deletion; audit |

## Deferred (11) — dormant/empty feature tables, add when the feature activates
`builder_approvals(decided_by, requested_by)`, `builder_audit_events(actor)`,
`builder_runs(requested_by)`, `builder_tool_calls(acting_user, approval_id, step_id)`,
`cgc_population_cards(population_set_id)`, `cgc_population_import_runs(requested_by, set_id)`,
`ebay_notifications(ebay_account_id)`. These tables are empty and behind not-yet-live
features (`/builder`, CGC population import, eBay); indexing them now is premature.
Track them with the owning feature's activation.

## Redundancy check
Each index leads with an FK column that is **not** already the leading column of any
existing index (verified against `pg_index`). `IF NOT EXISTS` guards against re-runs but
**only checks the index name** — the executable verification below checks the actual
definition so a same-name index with a different definition cannot pass silently.

## Lock / deployment
A plain `CREATE INDEX` takes a **`SHARE` lock** on the table: concurrent **reads
continue**, but **writes are blocked** while the index builds. On the current targets
(0–26 rows) that is a few milliseconds. `CREATE INDEX CONCURRENTLY` avoids the write
block but has different restrictions and **cannot run inside a migration transaction**.

**STOP CONDITION:** before applying, check each target's real size/write-rate on
staging/production. If any target table is large or write-heavy such that a brief write
block is unsafe, remove that statement from the transactional migration and create the
index **out-of-band** with `CREATE INDEX CONCURRENTLY` (then verify it as below). Keep
plain `CREATE INDEX` only for tables verified to remain tiny at application time.

## Verification (owner, staging)
1. Apply to staging.
2. Run `release/evidence/verify-supporting-fk-indexes.sql` — asserts all 17 indexes
   exist AND that `pg_get_indexdef()` matches the expected table + leading FK column
   (fails on a missing index or a same-name/different-definition index).
3. Re-run the performance advisor and confirm exactly the 17 cleared and only the 11
   deferred remain (also proves none of the 17 duplicated a pre-existing index).
No behavioural tests — indexes don't change results.
