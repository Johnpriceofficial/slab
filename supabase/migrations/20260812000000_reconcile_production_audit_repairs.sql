-- ============================================================================
-- Reconcile the undocumented production migration `20260716083710`
-- (`production_audit_critical_repairs`).
--
-- That migration was applied DIRECTLY to the production database
-- (rcbwemkfcefarqnlgrmv) — it never existed in this repository. A database built
-- only from the committed migrations therefore DIVERGES from production; most
-- importantly it lacks the enum-normalization trigger that production relies on,
-- so the official-product confirmation path (which writes
-- candidate_image_type = 'catalog_product_image') would violate
-- slabs_candidate_image_type_chk on any fresh `db reset`, new Supabase branch,
-- preview/CI database, or disaster-recovery rebuild.
--
-- This is a FORWARD migration, placed after the current migration maximum
-- (20260811000000) — NOT a backdated 20260716 file. The original SQL references
-- objects created by LATER migrations (candidate_image_type @20260724/26,
-- inventory_status @20260728, raw_public_seq @20260805, parse_inventory_code
-- @20260804), so a backdated file would fail a chronological reset.
--
-- Every statement is idempotent. Production already contains these objects, so
-- re-applying there is a no-op; this migration is only meaningfully applied to
-- freshly-rebuilt databases, which is exactly the divergence being closed.
-- ============================================================================

-- 1. Enum-input normalization (the load-bearing fix) --------------------------
-- Production writes candidate_image_type = 'catalog_product_image' for an
-- official-product image, but slabs_candidate_image_type_chk only accepts
-- ('marketplace_offer_image','official_product_image'). A BEFORE trigger rewrites
-- the legacy value (and trims/lowercases inventory_status) before the row
-- constraint runs, so the write is legal.
create or replace function public.normalize_slab_enum_inputs()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.inventory_status is not null then
    new.inventory_status := lower(btrim(new.inventory_status));
  end if;
  if new.candidate_image_type = 'catalog_product_image' then
    new.candidate_image_type := 'official_product_image';
  end if;
  return new;
end;
$$;
-- Trigger-only helper: never callable directly by clients.
revoke all on function public.normalize_slab_enum_inputs() from public, anon, authenticated;

drop trigger if exists slabs_normalize_enum_inputs on public.slabs;
create trigger slabs_normalize_enum_inputs
  before insert or update on public.slabs
  for each row execute function public.normalize_slab_enum_inputs();

-- 2. search_path hardening on the functions the production migration pinned but
--    the repo left unpinned. Bodies are UNCHANGED from their committed
--    definitions (20260805 / 20260804); only `set search_path` (+ grants) added.
--    enforce_inventory_id_immutable() is intentionally NOT re-defined here — its
--    controlled search_path is already pinned by 20260811 (PR #48).
create or replace function public.assign_raw_card_inventory()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.inventory_sequence is null then
    new.inventory_prefix := 'R';
    new.inventory_sequence := nextval('public.raw_public_seq');
  end if;
  return new;
end;
$$;
revoke all on function public.assign_raw_card_inventory() from public, anon, authenticated;

create or replace function public.parse_inventory_code(p_query text)
returns table (prefix text, sequence integer)
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := upper(btrim(coalesce(p_query, '')));
begin
  if v ~ '^[A-Z][0-9]+$' then
    prefix := left(v, 1);
    sequence := substring(v from 2)::integer;
    return next;
  elsif v ~ '^[0-9]+$' then
    prefix := null;
    sequence := v::integer;
    return next;
  end if;
end;
$$;
-- parse_inventory_code IS called directly (resolve_slab_inventory / clients):
-- keep the committed grants, just add the pinned search_path above.
revoke all on function public.parse_inventory_code(text) from public, anon;
grant execute on function public.parse_inventory_code(text) to authenticated, service_role;

-- 3. Index reconciliation -----------------------------------------------------
-- Production dropped slab_comps_slab_idx and uses idx_slab_comps_slab_id. The
-- repo still creates the old name (20260710) and never the new one, so a fresh
-- reset ends up with the wrong/duplicate index. Converge on production's index.
drop index if exists public.slab_comps_slab_idx;
create index if not exists idx_slab_comps_slab_id on public.slab_comps (slab_id);
