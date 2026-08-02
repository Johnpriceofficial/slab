-- 20260915000000_grading_advisor_rls_hardening.sql
--
-- Corrective, idempotent RLS hardening for the grading-advisor tables deployed
-- by 20260912000000 (already live on staging + production). Fixes two confirmed
-- defects raised on PR #98:
--
--   P1 — cross-owner child-row injection. The run-linked child INSERT/UPDATE
--        policies verified only `owner_id = auth.uid()` and NOT that the
--        referenced grading_advice_runs parent belongs to the caller. A customer
--        who learned another customer's run_id could insert a child with
--        {victim run_id, attacker owner_id}, or UPDATE a child to point at a
--        victim's run. The FK proves the run exists, not that the caller owns it.
--
--   P2 — retired-parent standards visibility. grading_standards_versions was
--        readable on its own `status = 'active'` even after its parent grading
--        company was set to retired/stale/inactive.
--
-- No table structure change; no weakened RLS; no new browser write access.
-- Idempotent: each policy is dropped-if-exists then recreated. Matches the
-- corrected historical migration exactly (clean-from-zero == corrected live).

-- ---- P1: run-linked child tables require a caller-owned parent run ----------
do $$
declare t text;
begin
  foreach t in array array[
    'grading_image_quality_assessments','grading_condition_observations',
    'grading_company_grade_estimates','grading_grade_value_scenarios',
    'grading_cost_scenarios','grading_saved_recommendations'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format($f$
      create policy %I on public.%I for insert to authenticated
      with check (
        owner_id = auth.uid()
        and exists (
          select 1 from public.grading_advice_runs r
           where r.id = %I.run_id and r.owner_id = auth.uid()
        )
      );
    $f$, t || '_insert_own', t, t);

    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format($f$
      create policy %I on public.%I for update to authenticated
      using (
        owner_id = auth.uid()
        and exists (
          select 1 from public.grading_advice_runs r
           where r.id = %I.run_id and r.owner_id = auth.uid()
        )
      )
      with check (
        owner_id = auth.uid()
        and exists (
          select 1 from public.grading_advice_runs r
           where r.id = %I.run_id and r.owner_id = auth.uid()
        )
      );
    $f$, t || '_update_own', t, t, t);
  end loop;
end $$;

-- ---- P2: standards versions visible only under an active parent company -----
do $$
begin
  drop policy if exists grading_standards_versions_select_published
    on public.grading_standards_versions;
  create policy grading_standards_versions_select_published
    on public.grading_standards_versions
    for select to authenticated
    using (
      status = 'active'
      and exists (
        select 1 from public.grading_companies gc
         where gc.id = grading_standards_versions.company_id and gc.status = 'active'
      )
    );
end $$;
