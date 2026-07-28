-- ============================================================================
-- 20260906000000_account_deletion.sql
--
-- Supported customer-account deletion workflow.
--
-- WHY: 14 foreign keys reference auth.users with ON DELETE RESTRICT (11 in the
-- slab graph rooted at slabs.owner_id, 3 in the raw-scanner graph via
-- created_by). A raw `DELETE FROM auth.users` therefore FAILS for any account
-- that ever owned a slab or scanned a card, and there was no owner-scoped path
-- to clear that data or to clean up the private storage buckets. (An
-- account with zero inventory already deletes cleanly, because the remaining
-- FKs are ON DELETE CASCADE / SET NULL — customer_profiles, api_user_daily_usage,
-- slab_admins, ebay_oauth_states cascade; audit/actor columns null out.)
--
-- STRATEGY: transactional data purge through a privileged RPC, followed by
-- Auth-user deletion by a service-role caller.
--   Phase 1 (this RPC, one transaction, atomic): clear every RESTRICT-blocking
--     row the target owns — slab graph + raw-scanner graph — while preserving
--     the append-only audit_log and slab_deletion_tombstones evidence and
--     queuing both private storage buckets for the existing cleanup consumer.
--   Phase 2 (caller, service role): auth.admin.deleteUser(target). With every
--     RESTRICT dependency gone it now succeeds, and the CASCADE FKs remove the
--     customer_profiles row, quota rows, admin row and ebay oauth state.
--
-- AUTHORIZATION (fail-closed):
--   * auth.uid() must be present (else 42501);
--   * a customer may only purge their OWN account (p_user_id null or self);
--   * an administrator may purge any account, and that override is audited;
--   * a caller with no JWT identity (auth.uid() null) is refused.
--   Account deletion is a first-class authorized destructive operation and
--   deliberately does NOT depend on the admin break-glass slab_settings
--   .allow_hard_delete flag (that flag guards the admin *bulk* purge UI; a
--   user erasing their own account, or an audited admin action, is distinct).
--
-- RETAINED-DATA POLICY: audit_log and slab_deletion_tombstones survive
-- (append-only compliance/evidence). Their auth.users references are ON DELETE
-- SET NULL / plain-uuid, so once Phase 2 removes the Auth user no retained row
-- identifies the customer by a live user id. A final 'account_data_purged'
-- audit row is written carrying only the (soon-orphaned) target uuid and a
-- boolean admin-override flag — no email or other PII.
--
-- ATOMICITY: the whole purge runs inside one PL/pgSQL function == one
-- transaction, so a failure anywhere rolls the entire purge back — no partial,
-- inconsistent deletion is possible.
--
-- STORAGE: object bytes are not removed synchronously (there is no server-side
-- worker). Every path is durably enqueued in private.slab_storage_cleanup_queue
-- with its bucket_id ('slab-images' and 'card-scans'); the existing admin
-- cleanup consumer drains it. Rows enqueued here are safe to drain repeatedly.
--
-- This migration adds one function; it does NOT alter any existing table,
-- policy, grant, trigger or the existing purge_slabs admin function.
-- ============================================================================

create or replace function public.purge_customer_account_data(p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, private, storage, auth
as $$
declare
  v_actor          uuid := (select auth.uid());
  v_is_admin       boolean;
  v_target         uuid;
  v_admin_override boolean;
  v_slab_ids       uuid[];
  v_slabs_deleted  integer := 0;
  v_scans_deleted  integer := 0;
  v_paths_queued   integer := 0;
  v_queued         integer;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  v_is_admin := public.is_admin(v_actor);
  v_target   := coalesce(p_user_id, v_actor);

  if v_target <> v_actor and not v_is_admin then
    -- Customers may only erase their own account.
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  v_admin_override := (v_target <> v_actor and v_is_admin);

  -- Serialize with the admin bulk purge so storage-queue writes never race.
  perform pg_advisory_xact_lock(918273646);

  -- ---------------------------------------------------------------- slab graph
  select coalesce(array_agg(s.id), '{}')
    into v_slab_ids
    from public.slabs s
   where s.owner_id = v_target;

  if cardinality(v_slab_ids) > 0 then
    -- Immutable evidence (survives the deletion).
    insert into private.slab_deletion_tombstones (
      slab_id, owner_id, inventory_number, inventory_code, card_name, grader, grade,
      certification_number, deleted_by, deleted_at
    )
    select s.id, s.owner_id, s.inventory_number, s.inventory_code, s.card_name,
           s.grader, s.grade, s.certification_number, v_actor, now()
      from public.slabs s
     where s.id = any(v_slab_ids)
    on conflict on constraint slab_deletion_tombstones_pkey do nothing;

    insert into public.audit_log (
      actor_user_id, action, entity_type, entity_id, source, detail, owner_id
    )
    select v_actor, 'hard_delete', 'slab', s.id::text, 'account_deletion',
           jsonb_build_object(
             'slab_id', s.id,
             'inventory_number', s.inventory_number,
             'inventory_code', s.inventory_code,
             'storage_cleanup_queued', true,
             'admin_override', v_admin_override
           ),
           s.owner_id
      from public.slabs s
     where s.id = any(v_slab_ids);

    -- Queue every slab-images object (front/back + slab_images + derivatives +
    -- any orphan object under slabs/<inventory_number>/) for async removal.
    -- DISTINCT ON (storage_path): a saved slab's front image appears in
    -- slabs.front_image_path, slab_images.storage_path AND storage.objects, so
    -- the UNION emits the same path several times. storage_path is the queue's
    -- primary key, and an ON CONFLICT that touched the same target row twice in
    -- one statement would raise a cardinality violation and abort the whole
    -- purge — collapse to one row per path first (as purge_slabs does).
    insert into private.slab_storage_cleanup_queue (bucket_id, storage_path, slab_id)
    select distinct on (paths.storage_path)
           'slab-images', paths.storage_path, paths.source_slab_id
      from (
        select s.front_image_path as storage_path, s.id as source_slab_id
          from public.slabs s where s.id = any(v_slab_ids)
        union all
        select s.back_image_path, s.id
          from public.slabs s where s.id = any(v_slab_ids)
        union all
        select si.storage_path, si.slab_id
          from public.slab_images si where si.slab_id = any(v_slab_ids)
        union all
        select d.storage_path, si.slab_id
          from public.image_derivatives d
          join public.slab_images si on si.id = d.slab_image_id
         where si.slab_id = any(v_slab_ids)
        union all
        select o.name, s.id
          from storage.objects o
          join public.slabs s
            on split_part(o.name, '/', 1) = 'slabs'
           and split_part(o.name, '/', 2) = s.inventory_number::text
         where o.bucket_id = 'slab-images'
           and s.id = any(v_slab_ids)
      ) paths
     where nullif(btrim(paths.storage_path), '') is not null
     order by paths.storage_path
    on conflict on constraint slab_storage_cleanup_queue_pkey
    do update set slab_id = excluded.slab_id, updated_at = now();
    get diagnostics v_queued = row_count;
    v_paths_queued := v_paths_queued + v_queued;

    -- Slab-referencing rows that are SET NULL on slab delete (would survive and
    -- keep owner_id RESTRICT), removed explicitly — same set purge_slabs clears.
    delete from private.ebay_order_line_items li where li.slab_id = any(v_slab_ids);
    delete from public.marketplace_events me where me.slab_id = any(v_slab_ids);
    delete from public.sold_comps sc where sc.slab_id = any(v_slab_ids);

    -- Deleting the slabs cascades slab_images -> image_derivatives, slab_comps,
    -- ai_analysis_runs, ai_field_evidence, valuation_snapshots,
    -- slab_product_links, slab_product_candidates, slab_pricecharting_events.
    delete from public.slabs s where s.id = any(v_slab_ids);
    get diagnostics v_slabs_deleted = row_count;
  end if;

  -- ---------------------------------------------------------- raw-scanner graph
  -- Queue card-scans objects (path = "<uid>/<scan>.jpg") for async removal.
  insert into private.slab_storage_cleanup_queue (bucket_id, storage_path, slab_id)
  select 'card-scans', cs.image_storage_path, null
    from public.card_scans cs
   where cs.created_by = v_target
     and nullif(btrim(cs.image_storage_path), '') is not null
  on conflict on constraint slab_storage_cleanup_queue_pkey
  do update set updated_at = now();
  get diagnostics v_queued = row_count;
  v_paths_queued := v_paths_queued + v_queued;

  -- cards.source_scan_id RESTRICTs its card_scan, so cards go first; deleting
  -- card_scans then cascades card_scan_reviews (scan_id ON DELETE CASCADE).
  delete from public.cards c where c.created_by = v_target;
  delete from public.card_scans cs where cs.created_by = v_target;
  get diagnostics v_scans_deleted = row_count;

  -- --------------------------------------------------------------- final record
  insert into public.audit_log (
    actor_user_id, action, entity_type, entity_id, source, detail, owner_id
  )
  values (
    v_actor, 'account_data_purged', 'account', v_target::text, 'account_deletion',
    jsonb_build_object(
      'admin_override', v_admin_override,
      'slabs_deleted', v_slabs_deleted,
      'card_scans_deleted', v_scans_deleted,
      'storage_paths_queued', v_paths_queued
    ),
    null
  );

  return jsonb_build_object(
    'target', v_target,
    'admin_override', v_admin_override,
    'slabs_deleted', v_slabs_deleted,
    'card_scans_deleted', v_scans_deleted,
    'storage_paths_queued', v_paths_queued
  );
end;
$$;

revoke all on function public.purge_customer_account_data(uuid) from public, anon;
grant execute on function public.purge_customer_account_data(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Make the storage-cleanup queue bucket-aware.
--
-- Account deletion queues card-scans objects (bucket_id = 'card-scans')
-- alongside slab-images objects. The existing list RPC returned only
-- storage_path, so the cleanup consumer removed every path from a hardcoded
-- 'slab-images' bucket and then acknowledged it — silently orphaning the
-- private card-scans image. Expose bucket_id so the consumer routes each
-- deletion to the bucket the row was recorded under. The delete order across
-- the RETURNS TABLE change requires a drop+recreate.
-- ----------------------------------------------------------------------------
drop function if exists public.list_pending_slab_storage_cleanup();

create function public.list_pending_slab_storage_cleanup()
returns table (bucket_id text, storage_path text)
language plpgsql
security definer
set search_path = public, private, auth
as $$
begin
  if not public.is_admin((select auth.uid())) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  return query
    select q.bucket_id, q.storage_path
    from private.slab_storage_cleanup_queue q
    order by q.created_at, q.storage_path;
end;
$$;

revoke all on function public.list_pending_slab_storage_cleanup() from public, anon;
grant execute on function public.list_pending_slab_storage_cleanup() to authenticated;
