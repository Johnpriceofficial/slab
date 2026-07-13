-- §3 Consolidate valuation_confidence to five canonical levels. Forward-only.
-- Legacy values are normalized WITHOUT changing meaning:
--   "exact"    was a top IDENTITY match (not a tier-verified value) → "high"
--   "probable" was a mid match                                      → "moderate"
-- "verified", "high", "moderate", "low", "manual" are unchanged. A CHECK
-- constraint then keeps the column canonical. ("Unavailable" is a display state,
-- never stored as a confidence value.)
update public.slabs set valuation_confidence = 'high'     where valuation_confidence = 'exact';
update public.slabs set valuation_confidence = 'moderate' where valuation_confidence = 'probable';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'slabs_valuation_confidence_chk') then
    alter table public.slabs add constraint slabs_valuation_confidence_chk check (
      valuation_confidence is null or valuation_confidence in ('verified', 'high', 'moderate', 'low', 'manual')
    );
  end if;
end $$;
