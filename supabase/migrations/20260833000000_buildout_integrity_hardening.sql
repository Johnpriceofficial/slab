-- GradedCardValue buildout integrity hardening.
-- Forward-only: preserve deletion evidence, queue every slab image object, restore
-- permanent public-ID semantics, persist canonical finish/franchise fields, and
-- derive acquisition date from the earliest original image submission.

-- Canonical identity fields that the analyzer already proposes.
alter table public.slabs add column if not exists finish text;
comment on column public.slabs.finish is
  'Canonical card finish (for example Holo or Reverse Holo), separate from rarity and variation.';

-- Conservative deterministic derivation for legacy/front-only records. Explicit
-- operator/AI values always win; inference fills blanks only.
create or replace function public.derive_slab_identity_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_text text := lower(coalesce(new.label_description, '') || ' ' || coalesce(new.variation, ''));
begin
  if nullif(btrim(new.game_or_franchise), '') is null
     and v_text ~ '(pokemon|pokémon)' then
    new.game_or_franchise := 'Pokémon';
  end if;

  if nullif(btrim(new.finish), '') is null then
    if v_text ~ 'reverse[ -]?holo' then
      new.finish := 'Reverse Holo';
    elsif v_text ~ 'holo(graphic)?' then
      new.finish := 'Holo';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists slabs_derive_identity_fields on public.slabs;
create trigger slabs_derive_identity_fields
before insert or update of label_description, variation, game_or_franchise, finish
on public.slabs
for each row execute function public.derive_slab_identity_fields();

update public.slabs
   set game_or_franchise = game_or_franchise,
       finish = finish
 where nullif(btrim(game_or_franchise), '') is null
    or nullif(btrim(finish), '') is null;

-- Acquisition date is the server-side date of the earliest original image upload.
-- It fills only a blank value and never overwrites an operator-supplied date.
create or replace function public.set_slab_acquired_from_original_image()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_original then
    update public.slabs
       set acquired_at = coalesce(acquired_at, new.created_at::date)
     where id = new.slab_id
       and acquired_at is null;
  end if;
  return new;
end;
$$;
revoke all on function public.set_slab_acquired_from_original_image() from public, anon, authenticated;

drop trigger if exists slab_images_set_acquired_at on public.slab_images;
create trigger slab_images_set_acquired_at
after insert or update of is_original, created_at on public.slab_images
for each row execute function public.set_slab_acquired_from_original_image();

update public.slabs s
   set acquired_at = x.first_original_date
  from (
    select slab_id, min(created_at)::date as first_original_date
      from public.slab_images
     where is_original
     group by slab_id
  ) x
 where s.id = x.slab_id
   and s.acquired_at is null;

-- Keep create_slab as the single atomic allocator while persisting the identity
-- fields already present in the reviewed intake payload.
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
  v_seq integer;
  v_front_ext text;
  v_back_ext text;
  v_front_path text;
  v_back_path text;
  v_row public.slabs;
begin
  v_uid := (select auth.uid());
  if v_uid is null then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;

  if not public.is_admin(v_uid) then
    select p2.account_status into v_owner from public.customer_profiles p2 where p2.id = v_uid;
    if v_owner is distinct from 'active' then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
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
     where owner_id = v_uid
       and grader_normalized = v_grader_n
       and certification_number_normalized = v_cert_n
     limit 1;
    if v_existing is not null then
      raise exception 'DUPLICATE_CERTIFICATION' using errcode = '23505', detail = v_existing::text;
    end if;
  end if;

  v_num := nextval('public.slab_inventory_seq');
  v_seq := nextval('public.slab_public_seq');
  v_front_path := 'slabs/' || v_num || '/front.' || v_front_ext;
  v_back_path := case when v_back_ext is null then null else 'slabs/' || v_num || '/back.' || v_back_ext end;

  insert into public.slabs (
    owner_id, inventory_number, inventory_prefix, inventory_sequence, card_name,
    final_value_cents, quick_sale_value_cents, replacement_value_cents,
    grader, grade, grade_label, certification_number, set_name, card_number, year,
    language, rarity, finish, variation, game_or_franchise, label_description, label_accuracy,
    verification_status, valuation_confidence, valuation_provenance, duplicate_status,
    pricecharting_product_id, pricecharting_product_name, pricecharting_grade_field,
    pricecharting_value_cents, pricecharting_sales_volume, pricecharting_match_status,
    price_variance_percent, front_image_path, back_image_path, notes, date_valued,
    cost_basis_cents, acquired_at
  ) values (
    v_uid, v_num, 'S', v_seq, nullif(btrim(p->>'card_name'), ''),
    (p->>'final_value_cents')::bigint, (p->>'quick_sale_value_cents')::bigint,
    (p->>'replacement_value_cents')::bigint,
    v_grader, nullif(btrim(p->>'grade'), ''), nullif(btrim(p->>'grade_label'), ''), v_cert,
    nullif(btrim(p->>'set_name'), ''), nullif(btrim(p->>'card_number'), ''),
    (p->>'year')::integer, nullif(btrim(p->>'language'), ''), nullif(btrim(p->>'rarity'), ''),
    nullif(btrim(p->>'finish'), ''), nullif(btrim(p->>'variation'), ''),
    nullif(btrim(p->>'game_or_franchise'), ''), nullif(btrim(p->>'label_description'), ''),
    nullif(btrim(p->>'label_accuracy'), ''),
    coalesce(nullif(p->>'verification_status', ''), 'unverified'),
    nullif(p->>'valuation_confidence', ''),
    coalesce(nullif(p->>'valuation_provenance', ''), 'tier_unavailable'),
    coalesce(nullif(p->>'duplicate_status', ''), 'unique'),
    nullif(p->>'pricecharting_product_id', ''), nullif(p->>'pricecharting_product_name', ''),
    nullif(p->>'pricecharting_grade_field', ''), (p->>'pricecharting_value_cents')::bigint,
    (p->>'pricecharting_sales_volume')::integer, nullif(p->>'pricecharting_match_status', ''),
    (p->>'price_variance_percent')::numeric, v_front_path, v_back_path,
    nullif(p->>'notes', ''), coalesce((p->>'date_valued')::timestamptz, now()),
    (p->>'cost_basis_cents')::bigint, (p->>'acquired_at')::date
  ) returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.create_slab(jsonb, text, text) from public, anon;
grant execute on function public.create_slab(jsonb, text, text) to authenticated;

-- Public inventory codes are permanent identifiers. Remove the maintenance bypass
-- that contradicted the original never-reused contract.
create or replace function public.reassign_slab_inventory_id(p_slab_id uuid, p_sequence integer)
returns public.slabs
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin((select auth.uid())) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  raise exception 'INVENTORY_ID_IMMUTABLE' using errcode = '42501';
end;
$$;

create or replace function public.compact_slab_inventory_ids()
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin((select auth.uid())) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  raise exception 'INVENTORY_ID_IMMUTABLE' using errcode = '42501';
end;
$$;

-- Immutable deletion tombstones retain the minimum identity and actor evidence even
-- after a break-glass database purge. Existing audit_log rows are never deleted.
create table if not exists private.slab_deletion_tombstones (
  slab_id uuid primary key,
  owner_id uuid,
  inventory_number integer not null,
  inventory_code text,
  card_name text,
  grader text,
  grade text,
  certification_number text,
  deleted_by uuid,
  deleted_at timestamptz not null default now(),
  reason text not null default 'break_glass_hard_delete'
);
revoke all on table private.slab_deletion_tombstones from public, anon, authenticated;

create or replace function public.purge_slabs(p_ids uuid[])
returns table (slab_id uuid, front_image_path text, back_image_path text)
language plpgsql
security definer
set search_path = public, private, storage, auth
as $$
declare
  v_requested integer;
  v_found integer;
begin
  if not public.is_admin((select auth.uid())) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_ids is null or cardinality(p_ids) = 0 then raise exception 'NO_SLABS_SELECTED' using errcode = '22023'; end if;
  if not coalesce((select allow_hard_delete from public.slab_settings where id = true), false) then
    raise exception 'HARD_DELETE_DISABLED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(918273646);
  select count(*) into v_requested from (select distinct unnest(p_ids) as id) requested;
  select count(*) into v_found from public.slabs where id = any(p_ids);
  if v_found <> v_requested then raise exception 'SLAB_NOT_FOUND_OR_DUPLICATE_INPUT' using errcode = 'P0002'; end if;

  insert into private.slab_deletion_tombstones (
    slab_id, owner_id, inventory_number, inventory_code, card_name, grader, grade,
    certification_number, deleted_by, deleted_at
  )
  select id, owner_id, inventory_number, inventory_code, card_name, grader, grade,
         certification_number, (select auth.uid()), now()
    from public.slabs where id = any(p_ids)
  on conflict (slab_id) do nothing;

  insert into public.audit_log (actor_user_id, action, entity_type, entity_id, source, detail, owner_id)
  select (select auth.uid()), 'hard_delete', 'slab', s.id::text, 'admin_rpc',
         jsonb_build_object('slab_id', s.id, 'inventory_number', s.inventory_number,
                            'inventory_code', s.inventory_code, 'storage_cleanup_queued', true),
         s.owner_id
    from public.slabs s where s.id = any(p_ids);

  insert into private.slab_storage_cleanup_queue (storage_path, slab_id)
  select distinct paths.storage_path, paths.slab_id
    from (
      select s.front_image_path as storage_path, s.id as slab_id from public.slabs s where s.id = any(p_ids)
      union all
      select s.back_image_path, s.id from public.slabs s where s.id = any(p_ids)
      union all
      select si.storage_path, si.slab_id from public.slab_images si where si.slab_id = any(p_ids)
      union all
      select d.storage_path, si.slab_id
        from public.image_derivatives d join public.slab_images si on si.id = d.slab_image_id
       where si.slab_id = any(p_ids)
      union all
      select o.name, s.id
        from storage.objects o
        join public.slabs s on split_part(o.name, '/', 1) = 'slabs'
                           and split_part(o.name, '/', 2) = s.inventory_number::text
       where o.bucket_id = 'slab-images' and s.id = any(p_ids)
    ) paths
   where nullif(btrim(paths.storage_path), '') is not null
  on conflict (storage_path) do update set slab_id = excluded.slab_id, updated_at = now();

  return query select s.id, s.front_image_path, s.back_image_path
    from public.slabs s where s.id = any(p_ids) order by s.id;

  delete from private.ebay_order_line_items where ebay_order_line_items.slab_id = any(p_ids);
  delete from public.marketplace_events where marketplace_events.slab_id = any(p_ids);
  delete from public.sold_comps where sold_comps.slab_id = any(p_ids);
  -- audit_log is intentionally retained.
  delete from public.slabs where id = any(p_ids);
end;
$$;
revoke all on function public.purge_slabs(uuid[]) from public, anon;
grant execute on function public.purge_slabs(uuid[]) to authenticated;

-- Queue legacy storage objects whose slab row no longer exists. The normal cleanup
-- retry path can now remove the three known orphan originals without losing track.
insert into private.slab_storage_cleanup_queue (storage_path, slab_id)
select o.name, null
  from storage.objects o
 where o.bucket_id = 'slab-images'
   and split_part(o.name, '/', 1) = 'slabs'
   and split_part(o.name, '/', 2) ~ '^[0-9]+$'
   and not exists (
     select 1 from public.slabs s
      where s.inventory_number::text = split_part(o.name, '/', 2)
   )
on conflict (storage_path) do update set updated_at = now();

-- Hard deletion is break-glass and defaults off after every migration/deploy.
update public.slab_settings set allow_hard_delete = false, updated_at = now() where id = true;

comment on function public.reassign_slab_inventory_id(uuid, integer) is 'Disabled: public inventory identifiers are immutable and never reused.';
comment on function public.compact_slab_inventory_ids() is 'Disabled: public inventory identifiers are immutable and never reused.';
comment on table private.slab_deletion_tombstones is 'Immutable minimum deletion evidence retained when a slab is break-glass purged.';
