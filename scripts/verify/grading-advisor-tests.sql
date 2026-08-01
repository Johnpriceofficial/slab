begin;

truncate table
  public.grading_fee_add_ons,
  public.grading_service_levels,
  public.grading_fee_snapshots,
  public.grading_company_grade_scales,
  public.grading_standards_versions,
  public.grading_companies,
  public.grading_saved_recommendations,
  public.grading_cost_scenarios,
  public.grading_grade_value_scenarios,
  public.grading_company_grade_estimates,
  public.grading_condition_observations,
  public.grading_image_quality_assessments,
  public.grading_advice_runs,
  public.grading_batch_optimizations,
  public.grading_advice_quota_consumptions,
  public.grading_advisor_usage,
  public.user_roles,
  auth.users
restart identity cascade;

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'bob@example.test'),
  ('00000000-0000-0000-0000-0000000000c3', 'admin@example.test');

insert into public.user_roles (user_id, role)
values ('00000000-0000-0000-0000-0000000000c3', 'administrator'::public.app_role);

insert into public.grading_advisor_usage (
  owner_id,
  period_start,
  runs_used,
  runs_allowed,
  entitlement_source
)
values
  ('00000000-0000-0000-0000-0000000000a1', current_date, 0, 2, 'test'),
  ('00000000-0000-0000-0000-0000000000b2', current_date, 0, 1, 'test'),
  ('00000000-0000-0000-0000-0000000000c3', current_date, 0, 3, 'test');

insert into public.grading_companies (
  id,
  name,
  standards_source_url,
  standards_verified_at,
  standards_version,
  status
)
values
  ('active-co', 'Active Co', 'https://example.test/active', now(), 'v1', 'active'),
  ('draft-co', 'Draft Co', 'https://example.test/draft', now(), 'v1', 'draft'),
  ('retired-co', 'Retired Co', 'https://example.test/retired', now(), 'v1', 'retired');

insert into public.grading_company_grade_scales (company_id, grade, label)
values
  ('active-co', 9.0, 'Mint 9'),
  ('draft-co', 9.0, 'Draft 9'),
  ('retired-co', 9.0, 'Retired 9');

insert into public.grading_fee_snapshots (
  id,
  label,
  status,
  created_by,
  published_at
)
values
  ('10000000-0000-0000-0000-000000000001', 'Published snapshot', 'active', '00000000-0000-0000-0000-0000000000c3', now()),
  ('10000000-0000-0000-0000-000000000002', 'Draft snapshot', 'draft', '00000000-0000-0000-0000-0000000000c3', null),
  ('10000000-0000-0000-0000-000000000003', 'Retired snapshot', 'retired', '00000000-0000-0000-0000-0000000000c3', now());

insert into public.grading_service_levels (
  id,
  snapshot_id,
  company_id,
  name,
  region,
  currency,
  per_card_fee_cents,
  min_cards,
  source_url,
  last_verified_at,
  status
)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'active-co', 'Published service', 'US', 'USD', 2500, 1, 'https://example.test/service-published', now(), 'active'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'active-co', 'Draft snapshot service', 'US', 'USD', 2500, 1, 'https://example.test/service-draft', now(), 'active'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'active-co', 'Retired snapshot service', 'US', 'USD', 2500, 1, 'https://example.test/service-retired', now(), 'retired');

insert into public.grading_fee_add_ons (service_level_id, label, amount_cents, per_card)
values
  ('20000000-0000-0000-0000-000000000001', 'Published add-on', 100, true),
  ('20000000-0000-0000-0000-000000000002', 'Draft add-on', 100, true);

do $$
declare
  v_search_path text[];
begin
  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'consume_grading_advice_quota'
       and p.prosecdef
  ) then
    raise exception 'consume_grading_advice_quota must be SECURITY DEFINER';
  end if;

  select p.proconfig
    into v_search_path
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'consume_grading_advice_quota';

  if v_search_path is null or not ('search_path=pg_catalog, public' = any (v_search_path)) then
    raise exception 'consume_grading_advice_quota must pin search_path to pg_catalog, public';
  end if;

  if has_function_privilege('public', 'public.consume_grading_advice_quota(text)', 'execute') then
    raise exception 'PUBLIC must not execute consume_grading_advice_quota';
  end if;
  if has_function_privilege('anon', 'public.consume_grading_advice_quota(text)', 'execute') then
    raise exception 'anon must not execute consume_grading_advice_quota';
  end if;
  if not has_function_privilege('authenticated', 'public.consume_grading_advice_quota(text)', 'execute') then
    raise exception 'authenticated must execute consume_grading_advice_quota';
  end if;
  if has_table_privilege('authenticated', 'public.grading_advisor_usage', 'update') then
    raise exception 'authenticated must not update grading_advisor_usage directly';
  end if;
end
$$;

do $$
declare
  v_count integer;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);

  select count(*)
    into v_count
    from public.grading_advisor_usage
   where owner_id = '00000000-0000-0000-0000-0000000000b2';

  if v_count <> 0 then
    raise exception 'customer A must not read customer B quota rows';
  end if;

  execute 'reset role';
end
$$;

do $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);

  begin
    update public.grading_advisor_usage
       set runs_used = 99
     where owner_id = '00000000-0000-0000-0000-0000000000a1';
    raise exception 'authenticated direct UPDATE should have been denied';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'reset role';
end
$$;

update public.grading_advisor_usage
   set runs_used = runs_allowed
 where owner_id = '00000000-0000-0000-0000-0000000000a1';

do $$
declare
  v_allowed boolean;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);

  v_allowed := public.consume_grading_advice_quota('boundary-key');
  if v_allowed then
    raise exception 'quota boundary should deny a fresh consume';
  end if;

  execute 'reset role';
end
$$;

update public.grading_advisor_usage
   set runs_used = 0,
       runs_allowed = 2
 where owner_id = '00000000-0000-0000-0000-0000000000a1';

do $$
declare
  v_first boolean;
  v_second boolean;
  v_runs integer;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);

  v_first := public.consume_grading_advice_quota('idem-key');
  v_second := public.consume_grading_advice_quota('idem-key');

  if not v_first or not v_second then
    raise exception 'idempotent retry should return true for both calls';
  end if;

  select runs_used
    into v_runs
    from public.grading_advisor_usage
   where owner_id = '00000000-0000-0000-0000-0000000000a1';

  if v_runs <> 1 then
    raise exception 'idempotent retry must consume quota once, got %', v_runs;
  end if;

  execute 'reset role';
end
$$;

update public.grading_advisor_usage
   set runs_used = 1,
       runs_allowed = 2
 where owner_id = '00000000-0000-0000-0000-0000000000b2';

do $$
declare
  v_company_count integer;
  v_snapshot_count integer;
  v_service_count integer;
  v_add_on_count integer;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);

  select count(*) into v_company_count from public.grading_companies;
  select count(*) into v_snapshot_count from public.grading_fee_snapshots;
  select count(*) into v_service_count from public.grading_service_levels;
  select count(*) into v_add_on_count from public.grading_fee_add_ons;

  if v_company_count <> 1 then
    raise exception 'published companies should be readable exactly once, got %', v_company_count;
  end if;
  if v_snapshot_count <> 1 then
    raise exception 'published snapshots should be readable exactly once, got %', v_snapshot_count;
  end if;
  if v_service_count <> 1 then
    raise exception 'published service levels should be readable exactly once, got %', v_service_count;
  end if;
  if v_add_on_count <> 1 then
    raise exception 'published add-ons should be readable exactly once, got %', v_add_on_count;
  end if;

  if exists (select 1 from public.grading_companies where id in ('draft-co', 'retired-co')) then
    raise exception 'draft or retired companies must be hidden';
  end if;
  if exists (
    select 1
      from public.grading_fee_snapshots
     where id in (
       '10000000-0000-0000-0000-000000000002',
       '10000000-0000-0000-0000-000000000003'
     )
  ) then
    raise exception 'draft or retired snapshots must be hidden';
  end if;
  if exists (
    select 1
      from public.grading_service_levels
     where id in (
       '20000000-0000-0000-0000-000000000002',
       '20000000-0000-0000-0000-000000000003'
     )
  ) then
    raise exception 'draft or retired services must be hidden';
  end if;

  execute 'reset role';
end
$$;

do $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);

  if not public.has_role(auth.uid(), 'administrator'::public.app_role) then
    raise exception 'test administrator role not present';
  end if;

  begin
    insert into public.grading_companies (id, name, standards_source_url, status)
    values ('admin-write-attempt', 'Denied', 'https://example.test/denied', 'active');
    raise exception 'authenticated administrators must not have a grading catalog write surface';
  exception
    when insufficient_privilege then
      null;
  end;

  execute 'reset role';
end
$$;

rollback;
