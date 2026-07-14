-- ============================================================================
-- GradedCardValue.com — customer-owned slab inventories.
--
-- Until now every slab table was admin-only: `using (public.is_admin(...))`.
-- Verified customers can now scan, complete intake, and maintain their OWN
-- private slab inventory, while admins retain access to everything.
--
-- The security model:
--   * public.slabs gains owner_id (NOT NULL) — the single source of truth.
--   * Every per-slab child record (images, derivatives, comps, analysis,
--     evidence, valuation snapshots, product links/candidates, PriceCharting
--     confirmation events, audit rows) carries a denormalized owner_id that a
--     BEFORE trigger FORCES from the parent slab. A client cannot spoof it:
--     the trigger overwrites whatever was submitted, and the WITH CHECK policy
--     then rejects the row if the derived owner isn't the caller.
--   * Access is "owner OR admin", never "authenticated".
--   * Shared/administrative surfaces are deliberately NOT opened: marketplace
--     (pricecharting_offers/offer_events/sync_runs, marketplace_events), eBay,
--     slab_settings, slab_admins, CGC population, webhook_inbox,
--     integration_errors, and the API usage tables all stay admin-only.
--
-- Backfill: existing slabs predate ownership and belong to the operator, so
-- they are assigned to the earliest admin. If slabs exist but no admin does,
-- the migration ABORTS rather than silently orphaning production inventory.
--
-- Inventory numbering remains a single global sequence, so storage paths
-- (slabs/{inventory_number}/…) keep working and no image object has to move.
-- ============================================================================

-- ─── 1. Ownership column on the root table ──────────────────────────────────
alter table public.slabs
  add column if not exists owner_id uuid references auth.users(id) on delete restrict;

-- The backfill owner is TARGETED EXPLICITLY, never inferred.
--
-- An earlier draft picked "the earliest admin by created_at". That is exactly
-- the kind of implicit selector that drifts: grant a second admin, or reorder
-- account creation, and a re-run silently assigns an entire inventory to the
-- wrong person. Ownership of real inventory is not something a migration should
-- guess at, so the intended account is named here and then VERIFIED.
--
-- Resolution order:
--   1. app.slab_backfill_owner  — a UUID set for this session, if you want to
--      override without editing this file:
--        set local app.slab_backfill_owner = '00000000-…';
--   2. Otherwise the account named below.
--
-- The resolved account must exist AND be an admin, or the migration ABORTS with
-- the row count it refused to touch. It never falls back to a guess.
do $$
declare
  v_intended_email constant text := 'info@johnpricebookings.com';
  v_override text;
  v_owner uuid;
  v_owner_email text;
  v_is_admin boolean;
  v_orphans bigint;
begin
  select count(*) into v_orphans from public.slabs where owner_id is null;
  if v_orphans = 0 then
    return; -- fresh database (e.g. a preview branch), or already backfilled
  end if;

  v_override := nullif(current_setting('app.slab_backfill_owner', true), '');

  if v_override is not null then
    select u.id, u.email into v_owner, v_owner_email
      from auth.users u where u.id = v_override::uuid;
    if v_owner is null then
      raise exception
        'CANNOT_BACKFILL_SLAB_OWNER: app.slab_backfill_owner = % matches no auth.users row. '
        '% slab(s) were left untouched.', v_override, v_orphans;
    end if;
  else
    select u.id, u.email into v_owner, v_owner_email
      from auth.users u where lower(u.email) = lower(v_intended_email);
    if v_owner is null then
      raise exception
        'CANNOT_BACKFILL_SLAB_OWNER: the intended owner % does not exist in auth.users. '
        'Set app.slab_backfill_owner to the correct UUID, or fix the address in this migration. '
        '% slab(s) were left untouched.', v_intended_email, v_orphans;
    end if;
  end if;

  -- app_metadata is the sole admin authority (see public.is_admin). A non-admin
  -- must never become the owner of the entire pre-existing inventory.
  select coalesce((u.raw_app_meta_data->>'graded_card_value_admin')::boolean, false)
    into v_is_admin
    from auth.users u where u.id = v_owner;

  if not v_is_admin then
    raise exception
      'CANNOT_BACKFILL_SLAB_OWNER: the resolved owner % (%) is not an admin '
      '(app_metadata.graded_card_value_admin is not true). % slab(s) were left untouched.',
      v_owner_email, v_owner, v_orphans;
  end if;

  update public.slabs set owner_id = v_owner where owner_id is null;
  raise notice 'Backfilled % slab(s) to owner % (%).', v_orphans, v_owner_email, v_owner;
end $$;

alter table public.slabs alter column owner_id set not null;
create index if not exists slabs_owner_idx on public.slabs (owner_id);
create index if not exists slabs_owner_created_idx on public.slabs (owner_id, created_at desc);

-- ─── 2. Certification uniqueness becomes per-owner ───────────────────────────
-- A cert is a duplicate only WITHIN one account. Globally-unique certs would
-- both block a customer from entering a cert another account happens to hold
-- and leak that account's existence through the duplicate error.
drop index if exists public.slabs_grader_cert_normalized_uidx;

create unique index if not exists slabs_owner_grader_cert_normalized_uidx
  on public.slabs (owner_id, grader_normalized, certification_number_normalized)
  where grader_normalized is not null and certification_number_normalized is not null;

-- ─── 3. Ownership helpers ────────────────────────────────────────────────────
-- Callable from RLS policies and SECURITY DEFINER RPCs alike.
create or replace function public.can_access_slab(p_slab_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.slabs s
     where s.id = p_slab_id
       and (s.owner_id = (select auth.uid()) or public.is_admin((select auth.uid())))
  );
$$;
revoke all on function public.can_access_slab(uuid) from public, anon;
grant execute on function public.can_access_slab(uuid) to authenticated, service_role;

create or replace function public.slab_owner(p_slab_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.owner_id from public.slabs s where s.id = p_slab_id;
$$;
revoke all on function public.slab_owner(uuid) from public, anon;
grant execute on function public.slab_owner(uuid) to authenticated, service_role;

-- Resolves a slab-images storage object (slabs/{inventory_number}/…) to its
-- owner. Covers originals, normalized primaries, and derivatives alike, because
-- every object for a slab lives under that slab's folder.
create or replace function public.slab_object_owner(p_name text)
returns uuid
language sql
stable
security definer
set search_path = public, storage
as $$
  select s.owner_id
    from public.slabs s
   where (storage.foldername(p_name))[1] = 'slabs'
     and (storage.foldername(p_name))[2] = s.inventory_number::text
   limit 1;
$$;
revoke all on function public.slab_object_owner(text) from public, anon;
grant execute on function public.slab_object_owner(text) to authenticated, service_role;

-- ─── 4. Denormalized owner_id on every per-slab child record ─────────────────
alter table public.slab_images              add column if not exists owner_id uuid references auth.users(id) on delete restrict;
alter table public.image_derivatives        add column if not exists owner_id uuid references auth.users(id) on delete restrict;
alter table public.slab_comps               add column if not exists owner_id uuid references auth.users(id) on delete restrict;
alter table public.ai_analysis_runs         add column if not exists owner_id uuid references auth.users(id) on delete restrict;
alter table public.ai_field_evidence        add column if not exists owner_id uuid references auth.users(id) on delete restrict;
alter table public.valuation_snapshots      add column if not exists owner_id uuid references auth.users(id) on delete restrict;
alter table public.slab_product_links       add column if not exists owner_id uuid references auth.users(id) on delete restrict;
alter table public.slab_product_candidates  add column if not exists owner_id uuid references auth.users(id) on delete restrict;
alter table public.slab_pricecharting_events add column if not exists owner_id uuid references auth.users(id) on delete restrict;
alter table public.sold_comps               add column if not exists owner_id uuid references auth.users(id) on delete restrict;
alter table public.audit_log                add column if not exists owner_id uuid references auth.users(id) on delete set null;

-- Backfill each child from its parent slab.
update public.slab_images c set owner_id = s.owner_id from public.slabs s where s.id = c.slab_id and c.owner_id is null;
update public.slab_comps  c set owner_id = s.owner_id from public.slabs s where s.id = c.slab_id and c.owner_id is null;
update public.ai_analysis_runs c set owner_id = s.owner_id from public.slabs s where s.id = c.slab_id and c.owner_id is null;
update public.ai_field_evidence c set owner_id = s.owner_id from public.slabs s where s.id = c.slab_id and c.owner_id is null;
update public.valuation_snapshots c set owner_id = s.owner_id from public.slabs s where s.id = c.slab_id and c.owner_id is null;
update public.slab_product_links c set owner_id = s.owner_id from public.slabs s where s.id = c.slab_id and c.owner_id is null;
update public.slab_product_candidates c set owner_id = s.owner_id from public.slabs s where s.id = c.slab_id and c.owner_id is null;
update public.slab_pricecharting_events c set owner_id = s.owner_id from public.slabs s where s.id = c.slab_id and c.owner_id is null;
update public.sold_comps c set owner_id = s.owner_id from public.slabs s where s.id = c.slab_id and c.owner_id is null;
update public.image_derivatives d set owner_id = i.owner_id
  from public.slab_images i where i.id = d.slab_image_id and d.owner_id is null;
update public.audit_log a set owner_id = s.owner_id
  from public.slabs s
 where a.entity_type = 'slab' and a.owner_id is null
   and a.entity_id ~ '^[0-9a-f-]{36}$' and s.id = a.entity_id::uuid;

create index if not exists slab_images_owner_idx on public.slab_images (owner_id);
create index if not exists image_derivatives_owner_idx on public.image_derivatives (owner_id);
create index if not exists slab_comps_owner_idx on public.slab_comps (owner_id);
create index if not exists ai_analysis_runs_owner_idx on public.ai_analysis_runs (owner_id);
create index if not exists ai_field_evidence_owner_idx on public.ai_field_evidence (owner_id);
create index if not exists valuation_snapshots_owner_idx on public.valuation_snapshots (owner_id);
create index if not exists slab_product_links_owner_idx on public.slab_product_links (owner_id);
create index if not exists slab_product_candidates_owner_idx on public.slab_product_candidates (owner_id);
create index if not exists slab_pricecharting_events_owner_idx on public.slab_pricecharting_events (owner_id);
create index if not exists sold_comps_owner_idx on public.sold_comps (owner_id);
create index if not exists audit_log_owner_idx on public.audit_log (owner_id);

-- The trigger FORCES owner_id from the parent slab, so a caller cannot insert a
-- child row claiming an owner it does not have. Combined with the WITH CHECK
-- policy below, a customer writing a child of someone else's slab derives that
-- other owner and is then rejected — rather than silently succeeding.
create or replace function public.set_child_owner_from_slab()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select owner_id into v_owner from public.slabs where id = new.slab_id;
  -- ai_analysis_runs / ai_field_evidence / sold_comps may exist before they are
  -- linked to a slab; leave the pre-set owner alone until the link is made.
  if v_owner is not null then
    new.owner_id := v_owner;
  end if;
  return new;
end;
$$;
revoke all on function public.set_child_owner_from_slab() from public, anon, authenticated;

create or replace function public.set_derivative_owner_from_image()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select owner_id into v_owner from public.slab_images where id = new.slab_image_id;
  new.owner_id := v_owner;
  return new;
end;
$$;
revoke all on function public.set_derivative_owner_from_image() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'slab_images','slab_comps','ai_analysis_runs','ai_field_evidence',
    'valuation_snapshots','slab_product_links','slab_product_candidates',
    'slab_pricecharting_events','sold_comps'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_owner', t);
    execute format(
      'create trigger %I before insert or update on public.%I
         for each row execute function public.set_child_owner_from_slab()',
      t || '_set_owner', t
    );
  end loop;
end $$;

drop trigger if exists image_derivatives_set_owner on public.image_derivatives;
create trigger image_derivatives_set_owner
  before insert or update on public.image_derivatives
  for each row execute function public.set_derivative_owner_from_image();

-- ─── 5. Owner-or-admin RLS ───────────────────────────────────────────────────
drop policy if exists "slabs admin all" on public.slabs;
drop policy if exists "slab_comps admin all" on public.slab_comps;

create policy slabs_owner_or_admin on public.slabs
  for all to authenticated
  using (owner_id = (select auth.uid()) or public.is_admin((select auth.uid())))
  with check (owner_id = (select auth.uid()) or public.is_admin((select auth.uid())));

do $$
declare
  t text;
begin
  foreach t in array array[
    'slab_images','image_derivatives','slab_comps','ai_analysis_runs',
    'ai_field_evidence','valuation_snapshots','slab_product_links',
    'slab_product_candidates','sold_comps'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_admin_all', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_or_admin', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (owner_id = (select auth.uid()) or public.is_admin((select auth.uid())))
         with check (owner_id = (select auth.uid()) or public.is_admin((select auth.uid())))',
      t || '_owner_or_admin', t
    );
  end loop;
end $$;

-- slab_pricecharting_events is an append-only confirmation trail: an owner may
-- read and insert its own rows, but never update or delete them.
drop policy if exists "slab_pc_events admin read" on public.slab_pricecharting_events;
drop policy if exists "slab_pc_events admin insert" on public.slab_pricecharting_events;
drop policy if exists slab_pricecharting_events_owner_read on public.slab_pricecharting_events;
drop policy if exists slab_pricecharting_events_owner_insert on public.slab_pricecharting_events;

create policy slab_pricecharting_events_owner_read on public.slab_pricecharting_events
  for select to authenticated
  using (owner_id = (select auth.uid()) or public.is_admin((select auth.uid())));

create policy slab_pricecharting_events_owner_insert on public.slab_pricecharting_events
  for insert to authenticated
  with check (owner_id = (select auth.uid()) or public.is_admin((select auth.uid())));

-- audit_log stays append-only and is readable only for rows about your own
-- slabs. Rows with a NULL owner (system/administrative events) remain admin-only.
drop policy if exists audit_log_admin_all on public.audit_log;
drop policy if exists audit_log_owner_read on public.audit_log;

create policy audit_log_owner_read on public.audit_log
  for select to authenticated
  using (
    public.is_admin((select auth.uid()))
    or (owner_id is not null and owner_id = (select auth.uid()))
  );

-- ─── 6. Table privileges (RLS remains the boundary) ─────────────────────────
grant select, insert, update, delete on public.slab_images to authenticated;
grant select, insert, update, delete on public.image_derivatives to authenticated;
grant select, insert, update, delete on public.slab_comps to authenticated;
grant select on public.ai_analysis_runs, public.ai_field_evidence to authenticated;
grant select on public.valuation_snapshots, public.slab_product_links to authenticated;
grant select on public.slab_product_candidates, public.sold_comps to authenticated;
grant select, insert on public.slab_pricecharting_events to authenticated;
grant select on public.audit_log to authenticated;
-- The PriceCharting product catalog is shared reference data: readable by any
-- authenticated user, writable only by the service-role sync.
grant select on public.pricecharting_products to authenticated;
drop policy if exists pricecharting_products_admin_all on public.pricecharting_products;
drop policy if exists pricecharting_products_read on public.pricecharting_products;
create policy pricecharting_products_read on public.pricecharting_products
  for select to authenticated using (true);

-- ─── 7. RPCs: "admin only" becomes "owner or admin" ─────────────────────────

-- The intake duplicate check now sees ONLY the caller's own inventory, so it can
-- never reveal that another account holds a cert.
create or replace function public.check_slab_certification(p_grader text, p_cert text)
returns table (id uuid, inventory_number integer)
language sql
security definer
set search_path = public, auth
as $$
  select s.id, s.inventory_number
  from public.slabs s
  where s.owner_id = (select auth.uid())
    and public.normalize_grader(p_grader) is not null
    and public.normalize_cert(p_cert) is not null
    and s.grader_normalized = public.normalize_grader(p_grader)
    and s.certification_number_normalized = public.normalize_cert(p_cert)
  limit 1;
$$;
grant execute on function public.check_slab_certification(text, text) to authenticated;

-- create_slab: any verified, active account may create a slab — for ITSELF.
-- owner_id is taken from auth.uid() and is never accepted from the payload.
-- The duplicate-certification check is scoped to the caller's own inventory.
create or replace function public.create_slab(p jsonb, p_front_ext text, p_back_ext text)
returns public.slabs
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_owner text;
  v_uid uuid;
  v_grader text;
  v_cert text;
  v_grader_n text;
  v_cert_n text;
  v_existing integer;
  v_num integer;
  v_front_ext text;
  v_back_ext text;
  v_front_path text;
  v_back_path text;
  v_row public.slabs;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  -- A suspended or closed account cannot create inventory. Admins bypass the
  -- profile gate (staff accounts are provisioned outside the customer flow).
  if not public.is_admin(v_uid) then
    select p2.account_status into v_owner
      from public.customer_profiles p2 where p2.id = v_uid;
    if v_owner is distinct from 'active' then
      raise exception 'NOT_AUTHORIZED' using errcode = '42501';
    end if;
  end if;

  if p_front_ext is null or btrim(p_front_ext) = '' then
    raise exception 'FRONT_IMAGE_REQUIRED' using errcode = '22023';
  end if;

  v_front_ext := public.valid_image_ext(p_front_ext);
  v_back_ext := public.valid_image_ext(p_back_ext);
  v_grader := nullif(btrim(p->>'grader'), '');
  v_cert := nullif(btrim(p->>'certification_number'), '');
  v_grader_n := public.normalize_grader(v_grader);
  v_cert_n := public.normalize_cert(v_cert);

  perform pg_advisory_xact_lock(918273645);
  if v_grader_n is not null and v_cert_n is not null then
    select inventory_number into v_existing
      from public.slabs
     where owner_id = v_uid                 -- per-owner duplicate scope
       and grader_normalized = v_grader_n
       and certification_number_normalized = v_cert_n
     limit 1;
    if v_existing is not null then
      raise exception 'DUPLICATE_CERTIFICATION'
        using errcode = '23505', detail = v_existing::text;
    end if;
  end if;

  v_num := nextval('public.slab_inventory_seq');
  v_front_path := 'slabs/' || v_num || '/front.' || v_front_ext;
  v_back_path := case when v_back_ext is null then null
    else 'slabs/' || v_num || '/back.' || v_back_ext end;

  insert into public.slabs (
    owner_id, inventory_number, card_name,
    final_value_cents, quick_sale_value_cents, replacement_value_cents,
    grader, grade, grade_label, certification_number, set_name, card_number, year,
    language, rarity, variation, label_description, label_accuracy,
    verification_status, valuation_confidence, valuation_provenance, duplicate_status,
    pricecharting_product_id, pricecharting_product_name, pricecharting_grade_field,
    pricecharting_value_cents, pricecharting_sales_volume, pricecharting_match_status,
    price_variance_percent, front_image_path, back_image_path, notes, date_valued
  ) values (
    v_uid, v_num, nullif(btrim(p->>'card_name'), ''),
    (p->>'final_value_cents')::bigint,
    (p->>'quick_sale_value_cents')::bigint,
    (p->>'replacement_value_cents')::bigint,
    v_grader, nullif(btrim(p->>'grade'), ''), nullif(btrim(p->>'grade_label'), ''), v_cert,
    nullif(btrim(p->>'set_name'), ''), nullif(btrim(p->>'card_number'), ''),
    (p->>'year')::integer, nullif(btrim(p->>'language'), ''),
    nullif(btrim(p->>'rarity'), ''), nullif(btrim(p->>'variation'), ''),
    nullif(btrim(p->>'label_description'), ''), nullif(btrim(p->>'label_accuracy'), ''),
    coalesce(nullif(p->>'verification_status', ''), 'unverified'),
    nullif(p->>'valuation_confidence', ''),
    coalesce(nullif(p->>'valuation_provenance', ''), 'tier_unavailable'),
    coalesce(nullif(p->>'duplicate_status', ''), 'unique'),
    nullif(p->>'pricecharting_product_id', ''), nullif(p->>'pricecharting_product_name', ''),
    nullif(p->>'pricecharting_grade_field', ''), (p->>'pricecharting_value_cents')::bigint,
    (p->>'pricecharting_sales_volume')::integer, nullif(p->>'pricecharting_match_status', ''),
    (p->>'price_variance_percent')::numeric, v_front_path, v_back_path,
    nullif(p->>'notes', ''), coalesce((p->>'date_valued')::timestamptz, now())
  ) returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.create_slab(jsonb, text, text) to authenticated;

-- archive / unarchive: an owner may archive their own slab; admins, any slab.
create or replace function public.archive_slab(p_id uuid)
returns public.slabs
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_row public.slabs;
begin
  if not public.can_access_slab(p_id) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  update public.slabs
    set archived_at = coalesce(archived_at, now())
    where id = p_id
    returning * into v_row;
  if v_row.id is null then
    raise exception 'SLAB_NOT_FOUND' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

create or replace function public.unarchive_slab(p_id uuid)
returns public.slabs
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_row public.slabs;
begin
  if not public.can_access_slab(p_id) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  update public.slabs
    set archived_at = null
    where id = p_id
    returning * into v_row;
  if v_row.id is null then
    raise exception 'SLAB_NOT_FOUND' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- hard_delete_slab: still gated on slab_settings.allow_hard_delete (an
-- administrative switch), and now additionally scoped to slabs you may access.
-- It is ALSO used as the compensating cleanup when an image upload fails
-- mid-save, so an owner must be able to delete the row they just created.
create or replace function public.hard_delete_slab(p_id uuid)
returns table (front_image_path text, back_image_path text)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_front text;
  v_back  text;
  v_found boolean;
begin
  if not public.can_access_slab(p_id) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  if not coalesce((select allow_hard_delete from public.slab_settings limit 1), false) then
    raise exception 'HARD_DELETE_DISABLED' using errcode = '42501';
  end if;

  select s.front_image_path, s.back_image_path, true
    into v_front, v_back, v_found
    from public.slabs s
    where s.id = p_id;

  if not coalesce(v_found, false) then
    raise exception 'SLAB_NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from public.slab_comps where slab_id = p_id;
  delete from public.slabs where id = p_id;

  front_image_path := v_front;
  back_image_path := v_back;
  return next;
end;
$$;
grant execute on function public.hard_delete_slab(uuid) to authenticated;

-- ─── 8. slab-images storage: owner-or-admin, resolved from the object path ──
drop policy if exists "slab-images admin read"   on storage.objects;
drop policy if exists "slab-images admin insert" on storage.objects;
drop policy if exists "slab-images admin update" on storage.objects;
drop policy if exists "slab-images admin delete" on storage.objects;
drop policy if exists "slab-images owner read"   on storage.objects;
drop policy if exists "slab-images owner insert" on storage.objects;
drop policy if exists "slab-images owner update" on storage.objects;
drop policy if exists "slab-images owner delete" on storage.objects;

create policy "slab-images owner read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'slab-images'
    and (public.is_admin((select auth.uid()))
         or public.slab_object_owner(name) = (select auth.uid()))
  );

create policy "slab-images owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'slab-images'
    and (public.is_admin((select auth.uid()))
         or public.slab_object_owner(name) = (select auth.uid()))
  );

create policy "slab-images owner update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'slab-images'
    and (public.is_admin((select auth.uid()))
         or public.slab_object_owner(name) = (select auth.uid()))
  );

create policy "slab-images owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'slab-images'
    and (public.is_admin((select auth.uid()))
         or public.slab_object_owner(name) = (select auth.uid()))
  );

-- ─── 9. Remaining save-path RPCs: owner-or-admin ────────────────────────────
-- These three are called by the intake screen after create_slab, so a customer
-- must be able to run them against THEIR OWN slab — and only their own. Each
-- swaps its is_admin() gate for can_access_slab(p_slab_id); the bodies are
-- otherwise unchanged from their current definitions.

create or replace function public.apply_slab_pricing(
  p_slab_id uuid,
  p_tiers jsonb,
  p_raw jsonb,
  p_priced_at timestamptz,
  p_scalars jsonb default null
) returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_count integer := 0;
  v_has_scalars boolean := p_scalars is not null;
  v_apply_value boolean := coalesce((p_scalars->>'apply_value')::boolean, false);
  v_apply_provenance boolean := coalesce((p_scalars->>'apply_provenance')::boolean, false);
begin
  if not public.can_access_slab(p_slab_id) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_priced_at is null then
    raise exception 'PRICED_AT_REQUIRED' using errcode = '22023';
  end if;

  update public.slabs set
    pricecharting_tiers = p_tiers,
    pricecharting_raw = p_raw,
    pricecharting_priced_at = p_priced_at,
    pricecharting_product_id = case when v_has_scalars then p_scalars->>'product_id' else pricecharting_product_id end,
    pricecharting_product_name = case when v_has_scalars then p_scalars->>'product_name' else pricecharting_product_name end,
    pricecharting_grade_field = case when v_has_scalars then p_scalars->>'grade_field' else pricecharting_grade_field end,
    pricecharting_sales_volume = case when v_has_scalars then (p_scalars->>'sales_volume')::integer else pricecharting_sales_volume end,
    pricecharting_match_status = case when v_has_scalars then p_scalars->>'match_status' else pricecharting_match_status end,
    pricecharting_value_cents = case when v_apply_value then (p_scalars->>'value_cents')::bigint else pricecharting_value_cents end,
    price_variance_percent = case when v_apply_value then (p_scalars->>'variance')::numeric else price_variance_percent end,
    valuation_provenance = case when v_apply_provenance then p_scalars->>'valuation_provenance' else valuation_provenance end,
    valuation_confidence = case when v_apply_provenance then nullif(p_scalars->>'valuation_confidence', '') else valuation_confidence end
  where id = p_slab_id
    and (pricecharting_priced_at is null or pricecharting_priced_at <= p_priced_at);

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;
revoke all on function public.apply_slab_pricing(uuid, jsonb, jsonb, timestamptz, jsonb) from public, anon;
grant execute on function public.apply_slab_pricing(uuid, jsonb, jsonb, timestamptz, jsonb) to authenticated;

create or replace function public.link_ai_analysis_run(p_run_id uuid, p_slab_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.can_access_slab(p_slab_id) then
    raise exception 'not authorized to link analysis evidence' using errcode = '42501';
  end if;
  -- The BEFORE trigger stamps owner_id from the newly linked slab, so the run and
  -- its field evidence become readable by the owner at the moment they are linked.
  update public.ai_analysis_runs set slab_id = p_slab_id where id = p_run_id and slab_id is null;
  if not found then raise exception 'analysis run unavailable or already linked' using errcode = 'P0002'; end if;
  update public.ai_field_evidence set slab_id = p_slab_id where analysis_run_id = p_run_id;
end;
$$;
revoke all on function public.link_ai_analysis_run(uuid, uuid) from public, anon;
grant execute on function public.link_ai_analysis_run(uuid, uuid) to authenticated;

create or replace function public.record_pricecharting_confirmation(
  p_slab_id uuid,
  p_patch   jsonb,
  p_event   jsonb
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor uuid := (select auth.uid());
  v_is_user boolean := (p_patch ? 'visual_confirmation_at') and (p_patch->>'visual_confirmation_at') is not null;
begin
  if not public.can_access_slab(p_slab_id) then
    raise exception 'not authorized to record a PriceCharting confirmation' using errcode = '42501';
  end if;

  update public.slabs set
    candidate_image_url          = p_patch->>'candidate_image_url',
    candidate_image_source       = p_patch->>'candidate_image_source',
    candidate_image_type         = p_patch->>'candidate_image_type',
    candidate_image_retrieved_at = (p_patch->>'candidate_image_retrieved_at')::timestamptz,
    candidate_image_available    = (p_patch->>'candidate_image_available')::boolean,
    visual_confirmation_status   = p_patch->>'visual_confirmation_status',
    visual_confirmation_method   = p_patch->>'visual_confirmation_method',
    visual_confirmation_at       = (p_patch->>'visual_confirmation_at')::timestamptz,
    visual_confirmation_by       = case when v_is_user then v_actor else null end,
    visual_rejection_reason      = p_patch->>'visual_rejection_reason',
    visual_rejection_note        = p_patch->>'visual_rejection_note',
    product_confirmation_source  = p_patch->>'product_confirmation_source',
    product_confirmed_at         = (p_patch->>'product_confirmed_at')::timestamptz,
    scoring_version              = (p_patch->>'scoring_version')::integer
  where id = p_slab_id;

  if not found then
    raise exception 'slab % not found', p_slab_id using errcode = 'P0002';
  end if;

  insert into public.slab_pricecharting_events (slab_id, event_type, product_id, source, detail, created_by)
  values (
    p_slab_id,
    p_event->>'event_type',
    p_event->>'product_id',
    p_event->>'source',
    coalesce(p_event->'detail', '{}'::jsonb),
    v_actor
  );
end;
$$;
revoke all on function public.record_pricecharting_confirmation(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.record_pricecharting_confirmation(uuid, jsonb, jsonb) to authenticated;

comment on column public.slabs.owner_id is
  'Owning account. Customers see only their own slabs; admins see all.';
comment on function public.can_access_slab(uuid) is
  'True when the current user owns the slab or is an admin. Used by RLS and the slab RPCs.';
