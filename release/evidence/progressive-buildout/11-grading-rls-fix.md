# 11 — Grading-advisor RLS security fix (PR #98 review: P1 + P2)

Two confirmed defects in `20260912000000_grading_advisor` (already live on staging
+ production). Fixed at root cause: the **historical** migration is corrected
(clean-from-zero) AND a **forward corrective** migration `20260915000000` (idempotent
drop+recreate of only the affected policies) is applied to the deployed databases.
No table structure change; no weakened RLS; no new browser write access.

## P1 — cross-owner child-row injection (was exploitable)
Run-linked child INSERT/UPDATE policies checked only `owner_id = auth.uid()`, not
that the referenced `grading_advice_runs` parent belonged to the caller. A customer
who learned another customer's `run_id` could insert `{victim run_id, attacker
owner_id}` or UPDATE a child onto a victim's run (the FK proves existence, not
ownership). Fixed on **all six** run-linked child tables
(`grading_image_quality_assessments`, `grading_condition_observations`,
`grading_company_grade_estimates`, `grading_grade_value_scenarios`,
`grading_cost_scenarios`, `grading_saved_recommendations`): INSERT `WITH CHECK`
and UPDATE `USING` + `WITH CHECK` now also require
`exists (select 1 from public.grading_advice_runs r where r.id = <child>.run_id and r.owner_id = auth.uid())`.
SELECT/DELETE stay owner-scoped. `grading_advice_runs` (the parent) and
`grading_batch_optimizations` (no `run_id`) remain owner-only.

## P2 — retired-parent standards visibility
`grading_standards_versions` was readable on its own `status='active'` even after
its parent grading company was retired/stale/inactive. SELECT now also requires
`exists (select 1 from public.grading_companies gc where gc.id = grading_standards_versions.company_id and gc.status = 'active')`
— the same active-parent pattern as grade scales / service levels.

## Before → after (production `rcbwemkfcefarqnlgrmv`, captured)
| Policy | Before | After |
| --- | --- | --- |
| 6× `grading_*_insert_own` WITH CHECK | `(owner_id = auth.uid())` | `owner_id=auth.uid()` **AND** parent-run owned |
| 6× `grading_*_update_own` USING+WITH CHECK | `(owner_id = auth.uid())` | `owner_id=auth.uid()` **AND** parent-run owned (both clauses) |
| `grading_standards_versions_select_published` USING | `(status = 'active')` | `status='active'` **AND** parent company active |
Verified post-apply: `children_insert_with_parent_check=6`, `children_update_with_parent_check=6`,
`standards_select_parent_company_check=true`, `grading_advice_runs` still owner-only.

## Verification
| Check | Result |
| --- | --- |
| clean-from-zero chain (77 migrations) | ✅ applied, 0 manual |
| schema-assertions | ✅ PASS |
| `grading-advisor-tests.sql` (adds P1 injection + P2 visibility) | ✅ PASS (disposable) |
| atomic-rate-limit + post-#95 admin/account-deletion | ✅ PASS |
| **live production behavioral** (synthetic, rolled back) | ✅ `same_owner_insert=t cross_owner_insert_denied=t reassign_denied=t` |
| integration test `grading-advisor-rls.integration.test.ts` | added (runs in `supabase-integration` CI) |
| production security advisors | ✅ 0 CRITICAL / 0 HIGH |
| staging security advisors | ✅ 0 CRITICAL / 0 HIGH |

## Applied to
disposable PostgreSQL ✅ · Supabase staging `msbdwwgojuvgnuugrrry` ✅ · Supabase
production `rcbwemkfcefarqnlgrmv` ✅ (ledger 82). Synthetic test data: 0 residue.
No customer data accessed; no weakened RLS; eBay mutations remain disabled.
