-- §4 follow-up: default the audit actor to the authenticated caller, so an
-- append that omits created_by still records WHO acted (the app also sets it
-- explicitly). Additive.
alter table public.slab_pricecharting_events alter column created_by set default auth.uid();
