-- ============================================================================
-- 20260905000000_analyze_slab_link_hardening.sql
--
-- Hardens public.link_ai_analysis_run(p_run_id, p_slab_id) for customer
-- traffic now that analyze-slab accepts authenticated, active, email-confirmed
-- customers (not only admins) and stamps owner_id on the runs and field
-- evidence it inserts.
--
-- Customer requirements enforced IN the function body (RLS-independent,
-- because the function is SECURITY DEFINER):
--   * auth.uid() must be present
--   * the destination slab must belong to auth.uid()
--   * the analysis run must exist, be unlinked, and be owned by auth.uid()
--   * an ownerless run is never linkable by a customer
--   * every ai_field_evidence row of the run must share the run's owner
--   * the run must be in a linkable status ('succeeded' / 'needs_review')
--
-- Explicitly authorized admin access is preserved: admins may link any
-- existing, unlinked run to any slab (their pre-existing capability), and the
-- existing set_child_owner_from_slab trigger still re-stamps owner_id from
-- the destination slab at link time.
--
-- Error codes are safe and distinguishable:
--   42501  insufficient_privilege  -> authorization refusals
--   P0002  no_data_found           -> missing slab / missing run
--   55000  object_not_in_prerequisite_state -> already linked / bad status
--
-- No table, policy, grant or trigger changes; function replacement only.
-- ============================================================================

create or replace function public.link_ai_analysis_run(p_run_id uuid, p_slab_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor        uuid := (select auth.uid());
  v_is_admin     boolean;
  v_slab_owner   uuid;
  v_run          public.ai_analysis_runs%rowtype;
  v_bad_evidence integer;
begin
  if v_actor is null then
    raise exception 'authentication required to link analysis evidence'
      using errcode = '42501';
  end if;
  v_is_admin := public.is_admin(v_actor);

  select owner_id into v_slab_owner from public.slabs where id = p_slab_id;
  if not found then
    raise exception 'destination slab not found'
      using errcode = 'P0002';
  end if;
  if not v_is_admin and (v_slab_owner is null or v_slab_owner <> v_actor) then
    raise exception 'not authorized to link analysis evidence to this slab'
      using errcode = '42501';
  end if;

  -- Lock the run row so two concurrent links cannot both pass the checks.
  select * into v_run from public.ai_analysis_runs where id = p_run_id for update;
  if not found then
    raise exception 'analysis run not found'
      using errcode = 'P0002';
  end if;
  if v_run.slab_id is not null then
    raise exception 'analysis run already linked'
      using errcode = '55000';
  end if;

  if not v_is_admin then
    if v_run.owner_id is null then
      -- A customer can never claim an ownerless run.
      raise exception 'analysis run has no owner'
        using errcode = '42501';
    end if;
    if v_run.owner_id <> v_actor then
      raise exception 'not authorized to link this analysis run'
        using errcode = '42501';
    end if;
    if v_run.status not in ('succeeded', 'needs_review') then
      raise exception 'analysis run is not in a linkable status'
        using errcode = '55000';
    end if;
    select count(*) into v_bad_evidence
      from public.ai_field_evidence e
      where e.analysis_run_id = p_run_id
        and e.owner_id is distinct from v_run.owner_id;
    if v_bad_evidence > 0 then
      raise exception 'analysis evidence ownership mismatch'
        using errcode = '42501';
    end if;
  end if;

  -- The BEFORE trigger stamps owner_id from the newly linked slab, so the run
  -- and its field evidence become readable by the owner at the moment they
  -- are linked (unchanged behavior).
  update public.ai_analysis_runs set slab_id = p_slab_id
    where id = p_run_id and slab_id is null;
  if not found then
    raise exception 'analysis run already linked'
      using errcode = '55000';
  end if;
  update public.ai_field_evidence set slab_id = p_slab_id
    where analysis_run_id = p_run_id;
end;
$$;

revoke all on function public.link_ai_analysis_run(uuid, uuid) from public, anon;
grant execute on function public.link_ai_analysis_run(uuid, uuid) to authenticated;
