-- =====================================================================
-- Grading Advisor foundation (canonicalized from frontend backend-patch
-- 20260731-grading-advisor). FORWARD-ONLY, environment-agnostic.
-- Canonicalization changes vs. the frontend patch:
--   * removed the staging-only production-refusal guard (canonical
--     migrations must run in every environment);
--   * removed the schema-wide `revoke all on all tables in schema public
--     from public` blanket (each grading table already revokes per-table;
--     the blanket would touch unrelated tables outside this migration).
-- Money is integer cents. Unknown is NULL, never 0. Only auth.users is an
-- external dependency; all other FKs are self-referential grading tables.
-- =====================================================================

-- ------------------------------------------------------------------ enums
do $$ begin
  create type public.grading_registry_status as enum ('draft','reviewed','active','stale','retired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.grading_defect_severity as enum ('none','minor','moderate','severe','unknown');
exception when duplicate_object then null; end $$;

-- --------------------------------------------------------- reference data
create table if not exists public.grading_companies (
  id text primary key,
  name text not null,
  uses_half_grades boolean not null default false,
  has_subgrades boolean not null default false,
  perfect_label text,
  standards_source_url text not null,
  standards_verified_at timestamptz,
  standards_version text,
  status public.grading_registry_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.grading_company_grade_scales (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references public.grading_companies(id) on delete cascade,
  grade numeric(4,1) not null,
  label text not null,
  unique (company_id, grade)
);

create table if not exists public.grading_standards_versions (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references public.grading_companies(id) on delete cascade,
  version text not null,
  source_url text not null,
  verified_at timestamptz,
  verified_by uuid references auth.users(id),
  status public.grading_registry_status not null default 'draft',
  notes text,
  created_at timestamptz not null default now(),
  unique (company_id, version)
);

create table if not exists public.grading_fee_snapshots (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  status public.grading_registry_status not null default 'draft',
  created_by uuid references auth.users(id),
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.grading_service_levels (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.grading_fee_snapshots(id) on delete cascade,
  company_id text not null references public.grading_companies(id) on delete restrict,
  name text not null,
  region text not null,
  currency text not null,
  per_card_fee_cents integer check (per_card_fee_cents >= 0),
  declared_value_ceiling_cents integer check (declared_value_ceiling_cents >= 0),
  min_cards integer not null default 1 check (min_cards >= 1),
  max_cards integer check (max_cards >= 1),
  membership_required boolean not null default false,
  membership_price_cents integer check (membership_price_cents >= 0),
  member_discount_bps integer check (member_discount_bps between 0 and 10000),
  estimated_turnaround_business_days integer check (estimated_turnaround_business_days >= 0),
  submission_form_fee_cents integer check (submission_form_fee_cents >= 0),
  effective_from timestamptz,
  effective_to timestamptz,
  source_url text not null,
  last_verified_at timestamptz,
  verified_by uuid references auth.users(id),
  status public.grading_registry_status not null default 'draft',
  unique (snapshot_id, company_id, name, region)
);

create table if not exists public.grading_fee_add_ons (
  id uuid primary key default gen_random_uuid(),
  service_level_id uuid not null references public.grading_service_levels(id) on delete cascade,
  label text not null,
  amount_cents integer check (amount_cents >= 0),
  per_card boolean not null default true
);

-- --------------------------------------------- customer-owned advice data
create table if not exists public.grading_advice_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  raw_card_id uuid,
  card_scan_id uuid,
  idempotency_key text not null,
  identity_version text,
  image_analysis_version text,
  ruleset_version text not null,
  fee_snapshot_id uuid references public.grading_fee_snapshots(id),
  pricing_snapshot_id uuid,
  engine_version text not null,
  status text not null default 'pending',
  stale_reason text,
  created_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);
create index if not exists grading_advice_runs_owner_created_idx
  on public.grading_advice_runs (owner_id, created_at desc);
create index if not exists grading_advice_runs_owner_card_idx
  on public.grading_advice_runs (owner_id, raw_card_id);

create table if not exists public.grading_image_quality_assessments (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.grading_advice_runs(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  front_present boolean not null,
  back_present boolean not null,
  blurred boolean not null,
  glare boolean not null,
  cropped boolean not null,
  obstructed boolean not null,
  image_hashes text[] not null default '{}',
  provider text,
  model text,
  schema_version text,
  prompt_version text,
  created_at timestamptz not null default now()
);

create table if not exists public.grading_condition_observations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.grading_advice_runs(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  area text not null,
  severity public.grading_defect_severity not null,
  note text,
  customer_corrected boolean not null default false
);

create table if not exists public.grading_company_grade_estimates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.grading_advice_runs(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company_id text not null references public.grading_companies(id),
  lower_grade numeric(4,1) not null,
  likely_grade numeric(4,1) not null,
  upper_grade numeric(4,1) not null,
  likelihood text not null,
  confidence text not null,
  subgrades jsonb,
  perfect_grade_eligible boolean not null default false,
  ruleset_version text not null,
  unique (run_id, company_id)
);

create table if not exists public.grading_grade_value_scenarios (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.grading_advice_runs(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company_id text not null references public.grading_companies(id),
  grade numeric(4,1) not null,
  grade_label text not null,
  market_value_cents integer,
  quick_sale_cents integer,
  replacement_cents integer,
  comparable_count integer not null default 0,
  evidence_from date,
  evidence_to date,
  source text,
  unique (run_id, company_id, grade)
);

create table if not exists public.grading_cost_scenarios (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.grading_advice_runs(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  service_level_id uuid references public.grading_service_levels(id),
  batch_size integer not null default 1 check (batch_size >= 1),
  known_subtotal_cents integer not null,
  total_cents integer,
  unknown_components text[] not null default '{}',
  lines jsonb not null default '[]'::jsonb
);

create table if not exists public.grading_saved_recommendations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.grading_advice_runs(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  recommendation text not null,
  company_id text references public.grading_companies(id),
  service_level_id uuid references public.grading_service_levels(id),
  incremental_profit_cents integer,
  break_even_grade numeric(4,1),
  downside_loss_cents integer,
  is_stale boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists grading_saved_recommendations_owner_idx
  on public.grading_saved_recommendations (owner_id, created_at desc);

create table if not exists public.grading_batch_optimizations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  optimizer_version text not null,
  constraints jsonb not null,
  plan jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.grading_advisor_usage (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  period_start date not null,
  runs_used integer not null default 0 check (runs_used >= 0),
  runs_allowed integer not null default 0 check (runs_allowed >= 0),
  entitlement_source text not null default 'none',
  updated_at timestamptz not null default now()
);

create table if not exists public.grading_advice_quota_consumptions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, idempotency_key)
);

-- ------------------------------------------------------------- privileges

do $$
declare t text;
begin
  foreach t in array array[
    'grading_advice_runs','grading_image_quality_assessments','grading_condition_observations',
    'grading_company_grade_estimates','grading_grade_value_scenarios','grading_cost_scenarios',
    'grading_saved_recommendations','grading_batch_optimizations'
  ] loop
    execute format('revoke all on public.%I from public, anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format($f$
      create policy %I on public.%I for select to authenticated using (owner_id = auth.uid());
    $f$, t || '_select_own', t);
    execute format($f$
      create policy %I on public.%I for insert to authenticated with check (owner_id = auth.uid());
    $f$, t || '_insert_own', t);
    execute format($f$
      create policy %I on public.%I for update to authenticated
      using (owner_id = auth.uid()) with check (owner_id = auth.uid());
    $f$, t || '_update_own', t);
    execute format($f$
      create policy %I on public.%I for delete to authenticated using (owner_id = auth.uid());
    $f$, t || '_delete_own', t);
  end loop;
end $$;

-- Usage counters are readable by the owner but only writable server-side.
revoke all on public.grading_advisor_usage from public, anon, authenticated;
grant select on public.grading_advisor_usage to authenticated;
grant all on public.grading_advisor_usage to service_role;
alter table public.grading_advisor_usage enable row level security;
create policy grading_advisor_usage_select_own on public.grading_advisor_usage
  for select to authenticated using (owner_id = auth.uid());

revoke all on public.grading_advice_quota_consumptions from public, anon, authenticated;
grant all on public.grading_advice_quota_consumptions to service_role;
alter table public.grading_advice_quota_consumptions enable row level security;
create policy grading_advice_quota_consumptions_service_role_only
  on public.grading_advice_quota_consumptions
  for all to service_role using (true) with check (true);

-- Reference/catalog tables: read-only for authenticated (active rows only),
-- writes restricted to service_role. Customers and anonymous users must not
-- read draft, pending, reviewed, stale, retired, or unpublished records.
do $$
declare
  t text;
begin
  -- Tables that carry their own `status` column. Only 'active' rows are
  -- customer-readable. Writes are service_role-only (migration / admin tools).
  foreach t in array array[
    'grading_companies','grading_standards_versions'
  ] loop
    execute format('revoke all on public.%I from public, anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format($f$
      create policy %I on public.%I for select to authenticated using (status = 'active');
    $f$, t || '_select_published', t);
    execute format($f$
      create policy %I on public.%I for all to service_role using (true) with check (true);
    $f$, t || '_service_write', t);
  end loop;
end $$;

do $$
begin
  -- grading_service_levels: active rows only when their company is active and
  -- their parent snapshot is both active and published.
  revoke all on public.grading_service_levels from public, anon;
  grant select on public.grading_service_levels to authenticated;
  grant all on public.grading_service_levels to service_role;
  alter table public.grading_service_levels enable row level security;
  create policy grading_service_levels_select_published
    on public.grading_service_levels for select to authenticated
    using (
      status = 'active'
      and exists (
        select 1
          from public.grading_companies gc
         where gc.id = company_id
           and gc.status = 'active'
      )
      and exists (
        select 1
          from public.grading_fee_snapshots fs
         where fs.id = snapshot_id
           and fs.status = 'active'
           and fs.published_at is not null
      )
    );
  create policy grading_service_levels_service_write
    on public.grading_service_levels for all to service_role
    using (true) with check (true);
end $$;

do $$
begin
  -- grading_fee_snapshots: active AND published (published_at IS NOT NULL).
  revoke all on public.grading_fee_snapshots from public, anon;
  grant select on public.grading_fee_snapshots to authenticated;
  grant all on public.grading_fee_snapshots to service_role;
  alter table public.grading_fee_snapshots enable row level security;
  create policy grading_fee_snapshots_select_published on public.grading_fee_snapshots
    for select to authenticated
    using (status = 'active' and published_at is not null);
  create policy grading_fee_snapshots_service_write on public.grading_fee_snapshots
    for all to service_role using (true) with check (true);
end $$;

do $$
begin
  -- grading_company_grade_scales: no own status; inherit from parent company.
  revoke all on public.grading_company_grade_scales from public, anon;
  grant select on public.grading_company_grade_scales to authenticated;
  grant all on public.grading_company_grade_scales to service_role;
  alter table public.grading_company_grade_scales enable row level security;
  create policy grading_company_grade_scales_select_published
    on public.grading_company_grade_scales for select to authenticated
    using (
      exists (
        select 1 from public.grading_companies gc
         where gc.id = company_id and gc.status = 'active'
      )
    );
  create policy grading_company_grade_scales_service_write
    on public.grading_company_grade_scales for all to service_role
    using (true) with check (true);
end $$;

do $$
begin
  -- grading_fee_add_ons: no own status; inherit from parent service level.
  revoke all on public.grading_fee_add_ons from public, anon;
  grant select on public.grading_fee_add_ons to authenticated;
  grant all on public.grading_fee_add_ons to service_role;
  alter table public.grading_fee_add_ons enable row level security;
  create policy grading_fee_add_ons_select_published
    on public.grading_fee_add_ons for select to authenticated
    using (
      exists (
      select 1
        from public.grading_service_levels sl
        join public.grading_fee_snapshots fs on fs.id = sl.snapshot_id
       where sl.id = service_level_id
         and sl.status = 'active'
         and fs.status = 'active'
         and fs.published_at is not null
      )
    );
  create policy grading_fee_add_ons_service_write
    on public.grading_fee_add_ons for all to service_role
    using (true) with check (true);
end $$;

-- Quota consumption: transactional and idempotent. Callers must supply the
-- idempotency key; a retry never consumes a second run.
--
-- Security model:
--  SECURITY DEFINER so the function runs as the owner (postgres) and can write
--  the grading_advisor_usage row even though authenticated users have only
--  SELECT on that table. Pinned search_path prevents search-path hijacking.
--  auth.uid() is read inside the function; the caller cannot supply a
--  different user id to escalate privileges.
--
-- Atomicity:
--  An advisory transaction lock serialises concurrent calls for the same
--  user. A server-owned idempotency ledger then ensures retries do not spend
--  quota twice, and the quota row is incremented exactly once for each fresh
--  key that still has remaining allowance.
create or replace function public.consume_grading_advice_quota(_idempotency_key text)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  _uid      uuid;
  _rows     integer;
  _idem_key text := btrim(coalesce(_idempotency_key, ''));
begin
  -- Resolve caller identity once; auth.uid() is always the JWT sub.
  _uid := auth.uid();
  if _uid is null then
    return false;
  end if;
  if _idem_key = '' then
    raise exception 'idempotency key must not be empty' using errcode = '22023';
  end if;

  -- Serialise concurrent calls for the same user with a per-user advisory
  -- transaction lock. The lock is released automatically at transaction end.
  perform pg_advisory_xact_lock(('x' || md5(_uid::text))::bit(64)::bigint);

  if exists (
    select 1
     from public.grading_advice_quota_consumptions
     where owner_id = _uid
      and idempotency_key = _idem_key
  ) then
    return true;
  end if;

  update public.grading_advisor_usage
     set runs_used = runs_used + 1,
         updated_at = now()
   where owner_id = _uid
     and runs_used < runs_allowed
  ;

  get diagnostics _rows = row_count;

  if _rows = 0 then
    return false;
  end if;

  insert into public.grading_advice_quota_consumptions (owner_id, idempotency_key)
  values (_uid, _idem_key);

  return true;
end $$;

revoke all on function public.consume_grading_advice_quota(text) from public, anon;
grant execute on function public.consume_grading_advice_quota(text) to authenticated;
