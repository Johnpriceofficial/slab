-- 20260909000000_least_privilege_authz_tables.sql
--
-- Least-privilege hardening for the authorization tables public.slab_admins
-- and public.user_roles.
--
-- WHY: a live grant audit found the client roles hold table-level privileges
-- that are never needed and are not gated by row-level security:
--
--   slab_admins  -> anon:          REFERENCES, TRIGGER, TRUNCATE
--                   authenticated: DELETE, INSERT, REFERENCES, SELECT,
--                                  TRIGGER, TRUNCATE, UPDATE
--   user_roles   -> authenticated: REFERENCES, SELECT, TRIGGER, TRUNCATE
--
-- TRUNCATE is the important one: it is a table-level command that bypasses
-- row-level security entirely, so no client role should ever hold it on an
-- authorization table. REFERENCES and TRIGGER are DDL-adjacent privileges the
-- browser client never needs. (PostgREST exposes no HTTP verb for any of the
-- three, so this is defence-in-depth, not an open remote hole — a customer JWT
-- was verified unable to INSERT/UPDATE/DELETE these tables via RLS.)
--
-- WHAT IS KEPT (intentionally):
--   * authenticated SELECT on user_roles   -> the "select own row" RLS policy.
--   * authenticated SELECT + DML on slab_admins -> the admin UI reads and edits
--     the admin list; every row is still gated by the is_admin() RLS policy, so
--     a non-admin authenticated caller changes nothing.
--   * anon keeps NOTHING on either table.
--
-- DEPENDENCY / ORDERING: the production migration ledger is currently out of
-- sync with this repo (canonical 20260905 / 20260907 / 20260908 are applied but
-- recorded under out-of-band versions 20260729131106 / 20260729131134, and
-- 20260906 account-deletion is not applied). Reconcile the ledger BEFORE
-- applying this migration, or `supabase db push` will fail on the prior gap.
-- See release/evidence/migration-ledger-reconciliation.md.
--
-- IDEMPOTENT: REVOKE of an absent privilege is a no-op, so this is safe to
-- re-run and safe if some privileges were already tightened by hand.

revoke truncate, references, trigger on table public.slab_admins from authenticated;
revoke all                          on table public.slab_admins from anon;

revoke truncate, references, trigger on table public.user_roles  from authenticated;
revoke all                          on table public.user_roles  from anon;
