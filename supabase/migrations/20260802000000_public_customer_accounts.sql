-- GradedCardValue.com public customer accounts.
-- Customer scanner data is owner-isolated; administrative slab and marketplace
-- tables remain protected by the existing immutable app_metadata admin role.

create table public.customer_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'paid', 'staff')),
  account_status text not null default 'active' check (account_status in ('active', 'suspended', 'closed')),
  daily_scan_limit integer not null default 5 check (daily_scan_limit between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.customer_profiles enable row level security;
revoke all on public.customer_profiles from public, anon;
grant select on public.customer_profiles to authenticated;
grant all on public.customer_profiles to service_role;

create policy customer_profiles_owner_read on public.customer_profiles
  for select to authenticated
  using (id = (select auth.uid()));

create or replace function public.create_customer_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customer_profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.create_customer_profile() from public, anon, authenticated;
grant execute on function public.create_customer_profile() to service_role;

drop trigger if exists create_customer_profile_after_signup on auth.users;
create trigger create_customer_profile_after_signup
  after insert on auth.users
  for each row execute function public.create_customer_profile();

insert into public.customer_profiles (id, plan, daily_scan_limit)
select u.id,
       case when coalesce((u.raw_app_meta_data->>'graded_card_value_admin')::boolean, false) then 'staff' else 'free' end,
       case when coalesce((u.raw_app_meta_data->>'graded_card_value_admin')::boolean, false) then 300 else 5 end
from auth.users u
on conflict (id) do nothing;

create table public.api_user_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket text not null,
  usage_date date not null default current_date,
  count integer not null default 0 check (count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, bucket, usage_date)
);

alter table public.api_user_daily_usage enable row level security;
revoke all on public.api_user_daily_usage from public, anon, authenticated;
grant all on public.api_user_daily_usage to service_role;

-- Atomically consumes one unit for a specific user. The profile limit controls
-- the plan allowance; p_hard_limit remains an operator-controlled spend cap.
create or replace function public.consume_user_daily_quota(
  p_user_id uuid,
  p_bucket text,
  p_hard_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_profile_limit integer;
  v_effective_limit integer;
begin
  if p_user_id is null or p_bucket is null or btrim(p_bucket) = '' then
    raise exception 'INVALID_QUOTA_INPUT' using errcode = '22023';
  end if;

  select p.daily_scan_limit into v_profile_limit
    from public.customer_profiles p
    where p.id = p_user_id and p.account_status = 'active';
  if v_profile_limit is null then return false; end if;

  v_effective_limit := greatest(least(v_profile_limit, coalesce(p_hard_limit, v_profile_limit)), 0);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(
    'user_daily_quota:' || p_user_id::text || ':' || p_bucket || ':' || current_date::text
  ));

  insert into public.api_user_daily_usage (user_id, bucket, usage_date, count)
    values (p_user_id, p_bucket, current_date, 0)
    on conflict (user_id, bucket, usage_date) do nothing;

  select u.count into v_count
    from public.api_user_daily_usage u
    where u.user_id = p_user_id and u.bucket = p_bucket and u.usage_date = current_date
    for update;

  if v_count >= v_effective_limit then return false; end if;

  update public.api_user_daily_usage
    set count = count + 1, updated_at = now()
    where user_id = p_user_id and bucket = p_bucket and usage_date = current_date;
  return true;
end;
$$;

revoke all on function public.consume_user_daily_quota(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.consume_user_daily_quota(uuid, text, integer) to service_role;

drop policy if exists card_scans_owner_admin_read on public.card_scans;
drop policy if exists cards_owner_admin_read on public.cards;
drop policy if exists card_scan_reviews_owner_admin_read on public.card_scan_reviews;

create policy card_scans_owner_read on public.card_scans
  for select to authenticated using (created_by = (select auth.uid()));
create policy cards_owner_read on public.cards
  for select to authenticated using (created_by = (select auth.uid()));
create policy card_scan_reviews_owner_read on public.card_scan_reviews
  for select to authenticated using (created_by = (select auth.uid()));

drop policy if exists "card-scans owner admin read" on storage.objects;
create policy "card-scans owner read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'card-scans'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

comment on table public.customer_profiles is 'Server-managed customer plan, status, and scanner allowance.';
comment on table public.api_user_daily_usage is 'Private atomic per-user usage counters for paid provider calls.';
