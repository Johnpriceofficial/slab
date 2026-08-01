-- Database-contract behavior tests (slab-native): administrator authority +
-- account deletion. Run against the disposable clean-installed schema.
-- RAISEs on any unmet assertion or missing fixture (nonzero via ON_ERROR_STOP).
\set ON_ERROR_STOP on

-- Fail if the objects under test are missing (never skip silently).
do $$ begin
  if (select count(*) from pg_proc where proname='is_admin')=0 then raise exception 'MISSING FIXTURE: is_admin'; end if;
  if (select count(*) from pg_proc where proname='purge_customer_account_data')=0 then raise exception 'MISSING FIXTURE: purge_customer_account_data'; end if;
end $$;

-- ---- Administrator authority (canonical app-metadata model) ----------------
do $$
declare a boolean; c boolean; u boolean; n boolean;
begin
  insert into auth.users(id,email,raw_app_meta_data) values
    ('00000000-0000-0000-0000-0000000000a1','admin@t','{"graded_card_value_admin": true}'::jsonb),
    ('00000000-0000-0000-0000-0000000000c2','cust@t','{}'::jsonb)
  on conflict (id) do update set raw_app_meta_data=excluded.raw_app_meta_data;
  a := public.is_admin('00000000-0000-0000-0000-0000000000a1');
  c := public.is_admin('00000000-0000-0000-0000-0000000000c2');
  u := public.is_admin('00000000-0000-0000-0000-0000000000ff');
  n := public.is_admin(null);
  if a is not true  then raise exception 'FAIL admin-authz: administrator must be allowed'; end if;
  if c is not false then raise exception 'FAIL admin-authz: customer must be denied'; end if;
  if u is not false then raise exception 'FAIL admin-authz: unknown user must be denied (no auto-promotion)'; end if;
  if coalesce(n,false) is not false then raise exception 'FAIL admin-authz: unauthenticated must be denied'; end if;
  raise notice 'PASS admin-authz: allowed/denied/denied/denied, fail-closed';
end $$;

-- ---- Account deletion (FK-safe purge + isolation + storage queue) -----------
do $$
declare tgt uuid := '00000000-0000-0000-0000-0000000d0001';
        oth uuid := '00000000-0000-0000-0000-0000000d0002';
        tgt_slabs int; oth_slabs int; queued int; identities int; refused boolean := false;
begin
  insert into auth.users(id,email,raw_app_meta_data) values (tgt,'del@t','{}'),(oth,'keep@t','{}') on conflict (id) do nothing;
  -- distinct high digits: inventory_code derives from the leading digits of
  -- inventory_number, so the two seeds must not share a prefix.
  insert into public.slabs(owner_id,inventory_number,inventory_sequence,verification_status,valuation_provenance,front_image_path)
    values (tgt,71001,71001,'unverified','tier_unavailable','slab-images/'||tgt||'/front.jpg');
  insert into public.slabs(owner_id,inventory_number,inventory_sequence,verification_status,valuation_provenance,front_image_path)
    values (oth,82001,82001,'unverified','tier_unavailable','slab-images/'||oth||'/front.jpg');

  begin
    perform set_config('request.jwt.claims','',true);
    perform public.purge_customer_account_data(tgt);
  exception when others then if sqlerrm like '%AUTH_REQUIRED%' then refused := true; end if; end;
  if not refused then raise exception 'FAIL account-deletion: unauthenticated caller not refused'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub',tgt::text,'role','authenticated')::text, true);
  perform public.purge_customer_account_data(tgt);
  perform set_config('request.jwt.claims','',true);

  select count(*) into tgt_slabs from public.slabs where owner_id=tgt;
  select count(*) into oth_slabs from public.slabs where owner_id=oth;
  select count(*) into queued    from private.slab_storage_cleanup_queue;
  select count(*) into identities from auth.users where id in (tgt,oth);
  if tgt_slabs  <> 0 then raise exception 'FAIL account-deletion: target data not cleaned'; end if;
  if oth_slabs  <> 1 then raise exception 'FAIL account-deletion: unrelated slab touched'; end if;
  if identities <> 2 then raise exception 'FAIL account-deletion: identity deleted by data-purge'; end if;
  if queued    <  1 then raise exception 'FAIL account-deletion: storage not enqueued'; end if;
  raise notice 'PASS account-deletion: unauth refused; FK-safe self-purge; target cleaned; unrelated intact; storage queued; identity retained for post-cleanup deletion';
end $$;
