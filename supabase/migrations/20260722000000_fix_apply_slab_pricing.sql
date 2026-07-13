-- Fix + harden apply_slab_pricing. Two problems in 20260721000000:
--   1. `get diagnostics <boolean> = row_count` then `return <boolean> > 0` raised
--      `operator does not exist: boolean > integer` on the admin happy path (the
--      non-admin path raised earlier, so the bug hid). ROW_COUNT is an integer.
--   2. Refresh persisted the scalar PriceCharting mirror fields in a SEPARATE,
--      UNGUARDED update, so the stale-write guard protected only the JSONB tiers.
--      A slower concurrent/late refresh could clobber newer scalar pricing, and a
--      failed second write left a torn row.
-- Fix: an integer row counter, and OPTIONAL scalar fields written ATOMICALLY with
-- the tiers under the one stale guard. Save passes no scalars (create_slab already
-- set them); refresh passes p_scalars and everything commits in a single guarded
-- statement. Value/variance are only written when the API had a value for the
-- grade (apply_value) so a hand-entered graded guide is never nulled.

drop function if exists public.apply_slab_pricing(uuid, jsonb, jsonb, timestamptz);

create or replace function public.apply_slab_pricing(
  p_slab_id   uuid,
  p_tiers     jsonb,
  p_raw       jsonb,
  p_priced_at timestamptz,
  p_scalars   jsonb default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count       integer := 0;
  v_has_scalars boolean := p_scalars is not null;
  v_apply_value boolean := coalesce((p_scalars->>'apply_value')::boolean, false);
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_priced_at is null then
    raise exception 'PRICED_AT_REQUIRED' using errcode = '22023';
  end if;

  update public.slabs
     set pricecharting_tiers    = p_tiers,
         pricecharting_raw       = p_raw,
         pricecharting_priced_at = p_priced_at,
         -- Scalar mirrors: written only on refresh (p_scalars provided), atomically
         -- with the tiers under the SAME stale guard below.
         pricecharting_product_id   = case when v_has_scalars then p_scalars->>'product_id'            else pricecharting_product_id end,
         pricecharting_product_name = case when v_has_scalars then p_scalars->>'product_name'          else pricecharting_product_name end,
         pricecharting_grade_field  = case when v_has_scalars then p_scalars->>'grade_field'           else pricecharting_grade_field end,
         pricecharting_sales_volume = case when v_has_scalars then (p_scalars->>'sales_volume')::integer else pricecharting_sales_volume end,
         pricecharting_match_status = case when v_has_scalars then p_scalars->>'match_status'          else pricecharting_match_status end,
         -- Guide + variance only when the API had a value for this grade; otherwise
         -- preserve a hand-entered graded guide (apply_value = false).
         pricecharting_value_cents  = case when v_apply_value then (p_scalars->>'value_cents')::bigint  else pricecharting_value_cents end,
         price_variance_percent     = case when v_apply_value then (p_scalars->>'variance')::numeric    else price_variance_percent end
   where id = p_slab_id
     -- Stale guard covers the WHOLE write (tiers AND scalars): only overwrite when
     -- the incoming response is at least as new as what is stored.
     and (pricecharting_priced_at is null or pricecharting_priced_at <= p_priced_at);

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

grant execute on function public.apply_slab_pricing(uuid, jsonb, jsonb, timestamptz, jsonb) to authenticated;
