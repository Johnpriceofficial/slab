# 04 — Remediation PR sequence (Phase 5)

Proven landing order (disposable PostgreSQL, clean from zero — see `03`):

```
main c65d438 (canonical →20260908)
  → 20260908500000 authority_foundation   [NEW — D-4 fix, on release branch]
  → 20260909  PR #94  least-privilege grants
  → 20260910  PR #95  admin authority unification (is_admin ← user_roles)
  → 20260911  PR #96  supporting FK indexes
  → 20260912  grading_advisor              [NEW]
  → 20260913  atomic_rate_limit_consume    [NEW]
```

## Dependency graph (inspected, not assumed)
- **#94 requires** `user_roles` + `slab_admins`. `slab_admins` is canonical
  (`20260709`); `user_roles` is **not** — supplied by the new foundation. Without
  the foundation, #94 fails (`relation "public.user_roles" does not exist`). ⇒ **#94
  must land after the foundation.**
- **#95 requires** `user_roles` + `app_role` + `has_role` + `slab_admins`; repoints
  `is_admin()` at `user_roles`; backfills from `slab_admins`; consistency-gates on
  app_metadata. ⇒ **after the foundation and independent of #94.**
- **#96** is independent (indexes only).
- **grading** requires only `auth.users`. **rate-limit** requires nothing extra.

## Phase-5 actions (owner-reviewed)
1. **Rebase PR #95 onto the authority foundation** (or fold the foundation into the
   front of #95 and order it before #94). This is the true F5 fix — #95 as drafted
   assumes an object it never creates.
2. Rebase #94 and #96 onto current `main`; confirm no new timestamp collisions.
3. Per-PR requirements to re-verify on staging before merge:
   - **#94**: privilege + customer-JWT denial checks; confirm no browser op depends
     on a revoked grant (`TRUNCATE`/`REFERENCES`/`TRIGGER` on `slab_admins`/`user_roles`).
   - **#95**: the mandatory abort scenario (an app_metadata-only admin must abort,
     not be silently promoted); admin/customer/unauth contexts; **prod pre-check:
     `unexpected_for_95_consistency_gate` must be 0** (currently 0 — see `06`).
   - **#96**: verify each index def; detect equivalent/redundant indexes; use a safe
     concurrent build where a blocking build is inappropriate.
4. Do **not** auto-merge on green preview. The final integration branch (this one,
   PR #98) carries the approved sequence for the Gate-A production apply.

## Status
- Disposable-PG proof of the full sequence: **DONE** (`03`).
- Staging application of #94/#95/#96: **PENDING** (owner-reviewed; staging already
  carries `user_roles` via `phase_2a`, so #95 there is a repoint, not a create).
