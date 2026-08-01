# Security verification

## Disposable clean schema (Test A)

| Check | Result |
| --- | --- |
| `SECURITY DEFINER` functions without pinned `search_path` (public+private) | **0 / 60** |
| `public` tables without RLS | **0 / 49** |
| `private` tables without RLS | **0 / 10** |
| Unprotected customer tables in an exposed schema | none |
| Foreign keys / triggers / policies | 88 / 28 / 50 |
| Administrator check fail-closed | yes (`is_admin` default false) |
| Account-deletion caller auth enforced | yes (`AUTH_REQUIRED` / `NOT_AUTHORIZED`) |

## Production (read-only advisors + metadata)

- Security advisors: **0 CRITICAL / 0 HIGH**.
- `rls_enabled_no_policy` (INFO ×14): all `private.*` (ebay_*, slab_deletion_
  tombstones, slab_storage_cleanup_queue) and `public.api_*` internal/service-role
  tables — RLS-on with no policy = deny-all to anon/authenticated **by design**.
- `authenticated_security_definer_function_executable` (WARN ×~30): the SECURITY
  DEFINER RPC surface. Prior deep audit confirmed each is internally guarded
  (live customer-JWT probes returned 403 on `purge_slabs`/`compact`/`reassign`/
  cleanup RPCs). Known, accepted set.
- `auth_leaked_password_protection` (WARN): HaveIBeenPwned check **disabled** —
  a one-click auth-hardening item (owner, Supabase Auth settings).

## Boundaries preserved

- No service-role key in browser/frontend build (`slab-scribe-pro` guards Whatnot
  secrets in browser env; prod CSP restricts `connect-src` to the prod Supabase).
- Production eBay mutation switches remain **disabled**.
- No RLS was bypassed to pass any test (tests set JWT/role context, never disabled
  RLS; account-deletion/admin tests exercise the real definer/auth paths).

## Fail-closed summary

Administrator authority, account-deletion authorization, and (in the frontend repo)
grading-quota / catalog / rate-limit all default to deny/false on the disposable
verifications. Production data-layer posture is unchanged (read-only session).
