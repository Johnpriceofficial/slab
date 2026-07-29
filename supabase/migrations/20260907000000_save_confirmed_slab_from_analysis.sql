-- ============================================================================
-- 20260907000000_save_confirmed_slab_from_analysis.sql
--
-- Atomic, idempotent final-save path for the confirmed-review flow.
--
-- Before this migration the frontend had to call public.create_slab and then
-- public.link_ai_analysis_run as two separate round trips. That is not atomic:
-- a create that succeeds followed by a link that fails leaves a slab with no
-- provenance, and a client retry creates a DUPLICATE_CERTIFICATION conflict
-- instead of converging. This migration adds ONE transactional wrapper:
--
--   public.save_confirmed_slab_from_analysis(
--     p_analysis_run_id uuid, p jsonb, p_front_ext text, p_back_ext text)
--   returns jsonb
--
-- ---------------------------------------------------------------------------
-- OWNERSHIP MODEL (single authoritative target owner)
-- ---------------------------------------------------------------------------
-- Canonical behavior this wrapper composes, read at
-- Johnpriceofficial/slab @ d8088f2a5379effc1fb82f2aea4b9d8c4e1d7271:
--
--   * public.create_slab(p, p_front_ext, p_back_ext) — 20260833000000 —
--     ALWAYS inserts owner_id = auth.uid(). It accepts no owner parameter and
--     reads no owner from `p`. Its duplicate-certification probe is scoped to
--     owner_id = auth.uid() as well.
--   * public.link_ai_analysis_run(p_run_id, p_slab_id) — 20260905000000 —
--     lets an admin link ANY unlinked run to ANY slab; a customer may only
--     link a run they own onto a slab they own, in status
--     'succeeded'/'needs_review', with owner-consistent field evidence.
--   * There is NO canonical owner-aware slab creation operation anywhere in
--     the repository (no owner-aware create variant, no owner-id argument, no
--     admin creation helper). Verified by repository-wide search.
--
-- Consequence: an administrator saving ANOTHER user's analysis run through
-- this wrapper could only ever create the slab under the ADMINISTRATOR's
-- inventory, silently taking ownership of a customer's card — or fail late at
-- link time. This migration therefore FAILS CLOSED (policy B):
--
--   v_target_owner := auth.uid(), for every caller, always.
--   The analysis run MUST be owned by v_target_owner, for every caller,
--   including administrators. An administrator saving someone else's run is
--   refused with 42501. No impersonation capability is introduced here.
--
-- v_target_owner is the ONLY owner used for: run-ownership authorization,
-- duplicate-certification lookup, slab creation (asserted post-insert),
-- linked-slab replay scoping, the audit row, and every returned field. No
-- owner id is ever read from the payload `p`.
--
-- Saveable status ('succeeded' / 'needs_review') is likewise enforced for
-- EVERY caller. Canonical policy documents no administrator override for
-- saving a 'running' or 'failed' run, so none is granted.
--
-- ---------------------------------------------------------------------------
-- GUARANTEES
-- ---------------------------------------------------------------------------
--   * ATOMIC     — the slab row, the provenance link and the audit row commit
--                  together or not at all. A link failure rolls the created
--                  slab back.
--   * IDEMPOTENT — the analysis run row is locked FOR UPDATE for the whole
--                  transaction. A repeat call for a run that is already
--                  linked returns result='already_saved' with the existing
--                  slab; it never creates a second slab and never errors.
--                  This holds for runs with no certification number too: the
--                  lock, not the certification, is the idempotency key.
--   * RACE-SAFE   — pg_advisory_xact_lock(918273645), the same lock canonical
--                  create_slab uses, is taken BEFORE the certification probe,
--                  so no concurrent intake can insert a matching
--                  grader/certification between the probe and the insert.
--   * OWNER-SCOPED — identity always comes from auth.uid(). No user id is
--                  ever accepted from the payload.
--   * NON-DESTRUCTIVE — nothing is updated, deleted or overwritten. An
--                  existing duplicate certification is reported, never
--                  replaced, and the run is left unlinked.
--   * ADDITIVE   — no table, policy, trigger, existing grant or existing
--                  function signature is changed. One new function only. The
--                  only privilege statements are the REVOKE/GRANT on that new
--                  function itself (revoked from public/anon, granted to
--                  authenticated), which disappear with it. Rollback is a
--                  single DROP FUNCTION; no data migration is involved.

--
-- Error codes are safe, enumerated and distinguishable:
--   42501  insufficient_privilege             -> authorization refusals
--   P0002  no_data_found                      -> analysis run not found
--   55000  object_not_in_prerequisite_state   -> status/prerequisite failure
--   22023  invalid_parameter_value            -> missing/invalid arguments
-- Duplicate certification is NOT an exception: it returns
-- result='duplicate_certification' so the client can show the existing item.
-- ============================================================================

create or replace function public.save_confirmed_slab_from_analysis(
  p_analysis_run_id uuid,
  p jsonb,
  p_front_ext text,
  p_back_ext text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor        uuid := (select auth.uid());
  v_target_owner uuid;
  v_is_admin     boolean;
  v_status       text;
  v_run          public.ai_analysis_runs%rowtype;
  v_slab         public.slabs%rowtype;
  v_grader_n     text;
  v_cert_n       text;
  v_dup          public.slabs%rowtype;
  v_bad_evidence integer;

begin
  if v_actor is null then
    raise exception 'authentication required to save a confirmed slab'
      using errcode = '42501';
  end if;

  -- ONE authoritative target owner, derived from server-owned data only.
  -- public.create_slab can only ever mint a slab for auth.uid(), so the target
  -- owner is auth.uid() for every caller and is never read from `p`.
  v_target_owner := v_actor;
  v_is_admin := public.is_admin(v_actor);

  if not v_is_admin then
    select cp.account_status into v_status
      from public.customer_profiles cp
     where cp.id = v_actor;
    if v_status is distinct from 'active' then
      raise exception 'not authorized to save a confirmed slab'
        using errcode = '42501';
    end if;
  end if;

  if p_analysis_run_id is null then
    raise exception 'ANALYSIS_RUN_REQUIRED' using errcode = '22023';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'SLAB_PAYLOAD_REQUIRED' using errcode = '22023';
  end if;
  if p_front_ext is null or btrim(p_front_ext) = '' then
    raise exception 'FRONT_IMAGE_REQUIRED' using errcode = '22023';
  end if;

  -- Serialize every save for this run. The lock is held to transaction end,
  -- so a concurrent duplicate call blocks here and then observes slab_id.
  select * into v_run
    from public.ai_analysis_runs
   where id = p_analysis_run_id
   for update;
  if not found then
    raise exception 'analysis run not found' using errcode = 'P0002';
  end if;

  -- Fail closed for EVERY caller, administrators included: the run must be
  -- owned by the target owner, because the slab can only be created for them.
  if v_run.owner_id is null then
    raise exception 'analysis run has no owner' using errcode = '42501';
  end if;
  if v_run.owner_id <> v_target_owner then
    raise exception 'not authorized to save this analysis run' using errcode = '42501';
  end if;

  -- Idempotent replay: the run is already linked to a slab.
  if v_run.slab_id is not null then
    select * into v_slab from public.slabs where id = v_run.slab_id;
    if not found then
      raise exception 'analysis run is linked to a slab that no longer exists'
        using errcode = '55000';
    end if;
    -- Scoped to the target owner for every caller, so no result can ever
    -- disclose another customer's slab.
    if v_slab.owner_id is null or v_slab.owner_id <> v_target_owner then
      raise exception 'not authorized to read the linked slab' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'result', 'already_saved',
      'created', false,
      'analysis_run_id', p_analysis_run_id,
      'analysis_run_linked', true,
      'owner_id', v_slab.owner_id,
      'slab_id', v_slab.id,
      'inventory_number', v_slab.inventory_number,
      'inventory_code', v_slab.inventory_code,
      'front_image_path', v_slab.front_image_path,
      'back_image_path', v_slab.back_image_path
    );
  end if;

  -- Saveable status is required of every caller; no administrator override.
  if v_run.status not in ('succeeded', 'needs_review') then
    raise exception 'analysis run is not in a saveable status' using errcode = '55000';
  end if;

  -- Defense in depth, uniform for every caller. Canonical
  -- public.link_ai_analysis_run applies its field-evidence ownership check
  -- only to non-admins, so an administrator saving their OWN run would skip
  -- it. This wrapper is self-owned-only, so the check is meaningful for every
  -- caller and is applied unconditionally: evidence attached to the run must
  -- belong to the target owner, or nothing is created.
  select count(*) into v_bad_evidence
    from public.ai_field_evidence e
   where e.analysis_run_id = p_analysis_run_id
     and e.owner_id is distinct from v_target_owner;
  if v_bad_evidence > 0 then
    raise exception 'analysis evidence ownership mismatch' using errcode = '42501';
  end if;


  -- Report an existing certification instead of failing the save with 23505,
  -- so a client retry after a lost response converges on a typed answer.
  -- Scoped to the target owner, matching create_slab's own duplicate probe.
  --
  -- RACE SAFETY: canonical public.create_slab takes pg_advisory_xact_lock(
  -- 918273645) and only then probes for a duplicate certification. Probing
  -- here WITHOUT that lock would leave a window in which a concurrent intake
  -- inserts the same normalized grader/certification between this probe and
  -- our create_slab call, turning a convergent 'duplicate_certification'
  -- answer into an uncaught 23505. Taking the SAME lock first closes the
  -- window: the probe and the subsequent insert are one serialized critical
  -- section. The lock is transaction scoped and re-entrant, so create_slab's
  -- own acquisition of it is a no-op, and it is released at commit/rollback.
  perform pg_advisory_xact_lock(918273645);

  v_grader_n := public.normalize_grader(nullif(btrim(p->>'grader'), ''));
  v_cert_n   := public.normalize_cert(nullif(btrim(p->>'certification_number'), ''));
  if v_grader_n is not null and v_cert_n is not null then
    select * into v_dup
      from public.slabs
     where owner_id = v_target_owner
       and grader_normalized = v_grader_n
       and certification_number_normalized = v_cert_n
     limit 1;
    if found then
      -- Reported, never overwritten, and the run is deliberately left
      -- unlinked so the client can decide what to do with the existing item.
      return jsonb_build_object(
        'result', 'duplicate_certification',
        'created', false,
        'analysis_run_id', p_analysis_run_id,
        'analysis_run_linked', false,
        'owner_id', v_dup.owner_id,
        'slab_id', v_dup.id,
        'inventory_number', v_dup.inventory_number,
        'inventory_code', v_dup.inventory_code,
        'front_image_path', v_dup.front_image_path,
        'back_image_path', v_dup.back_image_path
      );
    end if;
  end if;

  -- Both calls run inside this transaction: if the link raises, the created
  -- slab is rolled back with it. No orphan row, no orphan provenance.
  v_slab := public.create_slab(p, p_front_ext, p_back_ext);

  -- Defense in depth: create_slab owns to auth.uid(); if that ever changed,
  -- refuse and roll the whole transaction back rather than mis-own a card.
  if v_slab.owner_id is distinct from v_target_owner then
    raise exception 'created slab owner does not match the analysis run owner'
      using errcode = '42501';
  end if;

  perform public.link_ai_analysis_run(p_analysis_run_id, v_slab.id);

  insert into public.audit_log (
    actor_user_id, action, entity_type, entity_id, source, detail, owner_id
  ) values (
    v_actor,
    'slab.save_confirmed_from_analysis',
    'slab',
    v_slab.id::text,
    'rpc:save_confirmed_slab_from_analysis',
    -- Identifiers and booleans only: no image bytes, no image data URLs, no
    -- provider payload, no credential, no copy of `p`.
    jsonb_build_object(
      'analysis_run_id', p_analysis_run_id,
      'target_owner_id', v_target_owner,
      'inventory_number', v_slab.inventory_number,
      'inventory_code', v_slab.inventory_code,
      'has_back_image', v_slab.back_image_path is not null,
      'actor_role', case when v_is_admin then 'admin' else 'customer' end
    ),
    v_slab.owner_id
  );

  return jsonb_build_object(
    'result', 'created',
    'created', true,
    'analysis_run_id', p_analysis_run_id,
    'analysis_run_linked', true,
    'owner_id', v_slab.owner_id,
    'slab_id', v_slab.id,
    'inventory_number', v_slab.inventory_number,
    'inventory_code', v_slab.inventory_code,
    'front_image_path', v_slab.front_image_path,
    'back_image_path', v_slab.back_image_path
  );
end;
$$;

revoke all on function public.save_confirmed_slab_from_analysis(uuid, jsonb, text, text)
  from public, anon;
grant execute on function public.save_confirmed_slab_from_analysis(uuid, jsonb, text, text)
  to authenticated;
