# Environment manifest — disposable migration/contract verification

All work was performed on **disposable databases only**. Production Supabase
(`rcbwemkfcefarqnlgrmv`) was inspected **read-only, metadata-only** (no customer
rows, no writes, no ledger change). No migration was applied to production.

| Item | Value |
| --- | --- |
| Canonical backend repo | `Johnpriceofficial/slab` |
| Branch | `main` |
| Git SHA under test | `c65d438805a03e7c555a32337631b114b2e7ca69` |
| Worktree | clean (fresh clone) |
| Migration count | 69 |
| First migration | `20260709000000_slab_admin.sql` |
| Final migration | `20260908000000_slab_permission_model.sql` |
| Per-migration SHA-256 | see `migration-hashes.json` |
| Disposable PG image | `postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d` (`postgres:17`) |
| Disposable PG version | 17.10 |
| Production PG version | 17.6.1.141 (read-only) |
| Supabase CLI available | 2.109.1 |
| Docker | 29.6.2 |

## Supabase-environment bootstrap

The slab migrations depend only on a small, statically-provable platform
surface: `auth.users`/`auth.uid()`/`auth.role()`, `storage.objects`/`buckets`/
`foldername()`, and the four Supabase roles. **No vault, no pg_net, no custom
extensions** are referenced. `scripts/verify/supabase-bootstrap.sql` recreates
exactly this surface (the objects `supabase db reset` would provision) before
applying `supabase/migrations`. It contains no customer data and no secrets.

**Fidelity caveat:** the disposable environment is a faithful bootstrap of the
platform surface the migrations touch, not the full `supabase start` stack. The
migration DDL, ownership, grants, RLS and policies are the repository's own; only
the pre-existing `auth`/`storage` platform objects are bootstrapped.
