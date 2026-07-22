-- ============================================================================
-- PR C.8.1 (finding #1): sync-lease FENCING. A long paginated sync (up to 50
-- pages) can outlive a 300s lease; without fencing a second runner could acquire
-- an expired lease while the first is still working. This adds assert-and-extend
-- (mirrors the publish lease): the orchestrator extends the lease during
-- pagination and asserts it before mapping/persistence, and the atomic completion
-- RPC verifies the token under lock so a stale/expired runner cannot commit.
-- service_role only.
-- ============================================================================

create or replace function public.ebay_sync_lease_assert_and_extend(p_account_id uuid, p_resource_type text, p_token text, p_ttl_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_updated integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text || '|sync|' || coalesce(p_resource_type, ''), 0));
  update private.ebay_sync_leases
     set expires_at = v_now + make_interval(secs => greatest(1, p_ttl_seconds))
   where ebay_account_id = p_account_id and resource_type = p_resource_type and lease_token = p_token and expires_at > v_now;
  get diagnostics v_updated = row_count;
  return jsonb_build_object('held', v_updated = 1);
end;
$$;
revoke all on function public.ebay_sync_lease_assert_and_extend(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.ebay_sync_lease_assert_and_extend(uuid, text, text, integer) to service_role;
