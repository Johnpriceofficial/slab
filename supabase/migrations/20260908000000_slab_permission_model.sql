-- Customer slab permission model.
--
-- Direct browser writes to public.slabs are removed. Owner-scoped reads remain
-- available, trusted SECURITY DEFINER RPCs keep their existing behavior, and
-- customers receive one narrow, audited correction operation for identification
-- fields. The migration is additive except for tightening grants and RLS.

begin;

-- Direct writes are not a supported browser contract. create_slab, archive_slab,
-- pricing/verification RPCs and the correction RPC below remain the write paths.
revoke insert, update, delete, truncate, references, trigger on public.slabs from authenticated;
grant select on public.slabs to authenticated;
grant all on public.slabs to service_role;

alter table public.slabs enable row level security;

drop policy if exists "slabs_owner_or_admin" on public.slabs;
drop policy if exists "slabs_owner_select" on public.slabs;
drop policy if exists "slabs_admin_select" on public.slabs;

create policy "slabs_owner_select"
on public.slabs
for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "slabs_admin_select"
on public.slabs
for select
to authenticated
using (public.is_admin((select auth.uid())));

-- Defense in depth if a direct write grant is accidentally restored later.
-- Trusted service-role traffic and existing SECURITY DEFINER maintenance RPCs
-- continue to work; browser roles cannot mutate protected identity/system data.
create or replace function public.guard_slab_protected_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_setting('request.jwt.claim.role', true) = 'service_role'
     or current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.owner_id is distinct from old.owner_id
     or new.inventory_number is distinct from old.inventory_number
     or new.inventory_prefix is distinct from old.inventory_prefix
     or new.inventory_sequence is distinct from old.inventory_sequence
     or new.front_image_path is distinct from old.front_image_path
     or new.back_image_path is distinct from old.back_image_path
     or new.final_value_cents is distinct from old.final_value_cents
     or new.quick_sale_value_cents is distinct from old.quick_sale_value_cents
     or new.replacement_value_cents is distinct from old.replacement_value_cents
     or new.pricecharting_product_id is distinct from old.pricecharting_product_id
     or new.pricecharting_product_name is distinct from old.pricecharting_product_name
     or new.pricecharting_grade_field is distinct from old.pricecharting_grade_field
     or new.pricecharting_value_cents is distinct from old.pricecharting_value_cents
     or new.pricecharting_sales_volume is distinct from old.pricecharting_sales_volume
     or new.pricecharting_match_status is distinct from old.pricecharting_match_status
     or new.pricecharting_tiers is distinct from old.pricecharting_tiers
     or new.pricecharting_raw is distinct from old.pricecharting_raw
     or new.pricecharting_priced_at is distinct from old.pricecharting_priced_at
     or new.verification_status is distinct from old.verification_status
     or new.visual_confirmation_status is distinct from old.visual_confirmation_status
     or new.visual_confirmation_method is distinct from old.visual_confirmation_method
     or new.visual_confirmation_at is distinct from old.visual_confirmation_at
     or new.visual_confirmation_by is distinct from old.visual_confirmation_by
     or new.certification_verification_status is distinct from old.certification_verification_status
     or new.valuation_status is distinct from old.valuation_status
     or new.valuation_provenance is distinct from old.valuation_provenance then
    raise exception 'system_controlled_column'
      using errcode = '42501',
            detail = 'Permanent identity, storage, valuation, verification and provenance fields are system-controlled.';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_slab_protected_columns() from public, anon, authenticated;

drop trigger if exists slabs_guard_protected_columns on public.slabs;
create trigger slabs_guard_protected_columns
before update on public.slabs
for each row execute function public.guard_slab_protected_columns();

create or replace function public.forbid_direct_slab_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_setting('request.jwt.claim.role', true) = 'service_role'
     or current_user not in ('authenticated', 'anon') then
    return old;
  end if;

  raise exception 'direct_delete_forbidden'
    using errcode = '42501',
          detail = 'Customer slabs are archived through archive_slab; browser hard-delete is not permitted.';
end;
$$;

revoke all on function public.forbid_direct_slab_delete() from public, anon, authenticated;

drop trigger if exists slabs_forbid_direct_delete on public.slabs;
create trigger slabs_forbid_direct_delete
before delete on public.slabs
for each row execute function public.forbid_direct_slab_delete();

create table if not exists public.slab_correction_events (
  id uuid primary key default gen_random_uuid(),
  slab_id uuid not null references public.slabs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text,
  changes jsonb not null,
  created_at timestamptz not null default now()
);

comment on table public.slab_correction_events is
  'Owner-scoped, append-only audit records for correct_slab_identification.';

grant select on public.slab_correction_events to authenticated;
grant all on public.slab_correction_events to service_role;
revoke insert, update, delete, truncate, references, trigger on public.slab_correction_events from authenticated;

alter table public.slab_correction_events enable row level security;

drop policy if exists "slab_correction_events_owner_select" on public.slab_correction_events;
create policy "slab_correction_events_owner_select"
on public.slab_correction_events
for select
to authenticated
using (owner_id = (select auth.uid()));

create unique index if not exists slab_correction_events_idem_uidx
  on public.slab_correction_events (owner_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists slab_correction_events_slab_created_idx
  on public.slab_correction_events (slab_id, created_at desc);

create or replace function public.correct_slab_identification(
  p_slab_id uuid,
  p_corrections jsonb,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_user uuid := (select auth.uid());
  v_account_status text;
  v_allowed constant text[] := array[
    'card_name', 'set_name', 'card_number', 'year', 'language', 'rarity',
    'finish', 'variation', 'game_or_franchise', 'grader', 'grade',
    'grade_label', 'certification_number', 'label_description', 'notes'
  ];
  v_key text;
  v_patch jsonb := '{}'::jsonb;
  v_existing public.slab_correction_events%rowtype;
  v_slab public.slabs%rowtype;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'unauthenticated');
  end if;

  if not public.is_admin(v_user) then
    select cp.account_status into v_account_status
      from public.customer_profiles cp
     where cp.id = v_user;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'profile_missing');
    end if;
    if v_account_status <> 'active' then
      return jsonb_build_object('ok', false, 'error', 'account_' || v_account_status);
    end if;
  end if;

  if p_slab_id is null then
    return jsonb_build_object('ok', false, 'error', 'slab_required');
  end if;
  if p_corrections is null or jsonb_typeof(p_corrections) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'corrections_object_required');
  end if;

  p_idempotency_key := nullif(btrim(p_idempotency_key), '');
  if p_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtext(v_user::text || ':' || p_idempotency_key));
    select * into v_existing
      from public.slab_correction_events
     where owner_id = v_user
       and idempotency_key = p_idempotency_key;
    if found then
      if v_existing.slab_id <> p_slab_id then
        return jsonb_build_object('ok', false, 'error', 'idempotency_conflict');
      end if;
      return jsonb_build_object(
        'ok', true,
        'replayed', true,
        'slab_id', v_existing.slab_id,
        'changes', v_existing.changes
      );
    end if;
  end if;

  select * into v_slab
    from public.slabs
   where id = p_slab_id
     and owner_id = v_user
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  for v_key in select jsonb_object_keys(p_corrections) loop
    if not (v_key = any(v_allowed)) then
      return jsonb_build_object(
        'ok', false,
        'error', 'field_not_correctable',
        'field', v_key
      );
    end if;
    v_patch := v_patch || jsonb_build_object(v_key, p_corrections -> v_key);
  end loop;

  if v_patch = '{}'::jsonb then
    return jsonb_build_object('ok', false, 'error', 'no_corrections');
  end if;

  update public.slabs
     set card_name = case when v_patch ? 'card_name' then nullif(btrim(v_patch->>'card_name'), '') else card_name end,
         set_name = case when v_patch ? 'set_name' then nullif(btrim(v_patch->>'set_name'), '') else set_name end,
         card_number = case when v_patch ? 'card_number' then nullif(btrim(v_patch->>'card_number'), '') else card_number end,
         year = case when v_patch ? 'year' then nullif(btrim(v_patch->>'year'), '')::integer else year end,
         language = case when v_patch ? 'language' then nullif(btrim(v_patch->>'language'), '') else language end,
         rarity = case when v_patch ? 'rarity' then nullif(btrim(v_patch->>'rarity'), '') else rarity end,
         finish = case when v_patch ? 'finish' then nullif(btrim(v_patch->>'finish'), '') else finish end,
         variation = case when v_patch ? 'variation' then nullif(btrim(v_patch->>'variation'), '') else variation end,
         game_or_franchise = case when v_patch ? 'game_or_franchise' then nullif(btrim(v_patch->>'game_or_franchise'), '') else game_or_franchise end,
         grader = case when v_patch ? 'grader' then nullif(btrim(v_patch->>'grader'), '') else grader end,
         grade = case when v_patch ? 'grade' then nullif(btrim(v_patch->>'grade'), '') else grade end,
         grade_label = case when v_patch ? 'grade_label' then nullif(btrim(v_patch->>'grade_label'), '') else grade_label end,
         certification_number = case when v_patch ? 'certification_number' then nullif(btrim(v_patch->>'certification_number'), '') else certification_number end,
         label_description = case when v_patch ? 'label_description' then nullif(btrim(v_patch->>'label_description'), '') else label_description end,
         notes = case when v_patch ? 'notes' then nullif(btrim(v_patch->>'notes'), '') else notes end,
         updated_at = now()
   where id = p_slab_id
     and owner_id = v_user;

  insert into public.slab_correction_events (
    slab_id, owner_id, idempotency_key, changes
  ) values (
    p_slab_id, v_user, p_idempotency_key, v_patch
  );

  insert into public.audit_log (
    actor_user_id, action, entity_type, entity_id, source, detail, owner_id
  ) values (
    v_user,
    'slab.identification_corrected',
    'slab',
    p_slab_id::text,
    'rpc:correct_slab_identification',
    jsonb_build_object(
      'slab_id', p_slab_id,
      'corrected_fields', (
        select jsonb_agg(field_name order by field_name)
          from jsonb_object_keys(v_patch) as fields(field_name)
      ),
      'idempotency_key_present', p_idempotency_key is not null
    ),
    v_user
  );

  return jsonb_build_object(
    'ok', true,
    'replayed', false,
    'slab_id', p_slab_id,
    'changes', v_patch
  );
end;
$$;

revoke all on function public.correct_slab_identification(uuid, jsonb, text)
  from public, anon;
grant execute on function public.correct_slab_identification(uuid, jsonb, text)
  to authenticated, service_role;

commit;
