# Rollback plan

Nothing in this verification changed production, so **no rollback is currently
required**. The following applies to the owner-gated steps in the runbook.

## Frontend (Vercel/Cloudflare)
- Production `gradedcardvalue.com` is served by **Cloudflare** today. Until the
  domain is moved to the new Vercel project, the rollback lever is the Cloudflare
  Pages/DNS layer (owner-controlled).
- The existing Vercel project `slab-13rc` last **production-target** deployment is
  `dpl_4ToLaoBEKLxFNK9KemX3Agce1qAZ` (`slab` main `c65d438`, `isRollbackCandidate:
  true`) — but it builds the `slab`-embedded frontend, not `slab-scribe-pro`, and
  is not attached to the domain. It is not the rollback target for the new frontend.
- When the domain is cut over: keep the prior Cloudflare deployment live and revert
  the Cloudflare DNS record to it if the Vercel deployment misbehaves.

## Backend (Supabase migrations)
- **Ledger repair** (`131106→20260907`, `131134→20260908`) is reversible: repair
  the ledger id back; no object change is performed by a repair.
- **`CREATE OR REPLACE`** migrations (`20260905` link, `20260907` save_confirmed,
  `20260906` list_pending) are not auto-reversible — before applying, capture the
  current production definition (`pg_get_functiondef`) so it can be restored.
- **New object** (`20260906` `purge_customer_account_data`) can be dropped to roll
  back.
- Prod PG point-in-time recovery (Supabase backups) is the last resort; confirm the
  backup window before any production apply.

## Constraints
- Never roll back by editing production data manually.
- Rehearse both apply and rollback on staging before production.
