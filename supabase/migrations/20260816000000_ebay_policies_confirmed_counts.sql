-- ============================================================================
-- PR A.3: business-policies replace RPC returns CONFIRMED post-write counts
-- (total + per policy type) read back from the table, so account-sync reports
-- durable database counts instead of submitted in-memory row counts. Forward-only;
-- changing the return type requires drop + recreate. Locations replace already
-- returns a confirmed post-write count(*), so it is unchanged.
-- ============================================================================

drop function if exists public.ebay_business_policies_replace(uuid, jsonb);
create or replace function public.ebay_business_policies_replace(p_account_id uuid, p_policies jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids text[];
  v_result jsonb;
begin
  select coalesce(array_agg(x->>'policy_id'), '{}') into v_ids
    from jsonb_array_elements(coalesce(p_policies, '[]'::jsonb)) x;
  insert into public.ebay_business_policies (ebay_account_id, policy_id, policy_type, name, marketplace_id, last_synced_at)
  select p_account_id, x->>'policy_id', x->>'policy_type', x->>'name', x->>'marketplace_id', now()
    from jsonb_array_elements(coalesce(p_policies, '[]'::jsonb)) x
  on conflict (ebay_account_id, policy_id) do update
    set policy_type = excluded.policy_type, name = excluded.name, marketplace_id = excluded.marketplace_id, last_synced_at = excluded.last_synced_at;
  delete from public.ebay_business_policies
   where ebay_account_id = p_account_id and policy_id <> all(v_ids);
  -- CONFIRMED post-write counts read back from the table (not submitted rows).
  select jsonb_build_object(
           'total',       count(*),
           'fulfillment', count(*) filter (where policy_type = 'fulfillment'),
           'payment',     count(*) filter (where policy_type = 'payment'),
           'return',      count(*) filter (where policy_type = 'return')
         )
    into v_result
    from public.ebay_business_policies
   where ebay_account_id = p_account_id;
  return v_result;
end;
$$;
revoke all on function public.ebay_business_policies_replace(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ebay_business_policies_replace(uuid, jsonb) to service_role;
