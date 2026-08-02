# Test A — clean database from zero

**Result: PASS.** The complete canonical chain (69 migrations, `20260709…` →
`20260908…`) applied in exact repository order to an **empty** disposable
`postgres:17` over the Supabase bootstrap, with **zero manual interventions**.
The first attempt surfaced a *bootstrap* gap (real `storage.buckets` has
`file_size_limit`/`allowed_mime_types`); that is an environment-fidelity fix, not
a mid-chain database edit — the environment was completed and the chain re-run
from zero. No migration was edited to pass.

## Schema-property assertions on the clean schema

| Property | Result |
| --- | --- |
| `SECURITY DEFINER` functions without a pinned `search_path` | **0** |
| `public` tables with RLS **disabled** | **0** (all 49 have RLS on) |
| `private` tables with RLS on | 10 / 10 |
| Exposed schema unprotected customer tables | none |
| `SECURITY DEFINER` functions | 60 |
| Policies | 50 |
| Foreign keys | 88 |
| Triggers | 28 |
| `is_admin` present | yes (app-metadata model) |
| `purge_customer_account_data` present | yes |
| `slab_admins` present | yes |
| Undeclared manual object dependency | none found (chain applied over the bootstrap only) |

## Idempotency / supported-deployment rerun

Migrations are ledger-tracked (`supabase_migrations.schema_migrations`). Re-running
the supported deployment process re-applies **0** migrations (all versions
already ledgered) — no silently-created duplicate objects.

Reproduce: `scripts/verify/migration-chain.sh`.
