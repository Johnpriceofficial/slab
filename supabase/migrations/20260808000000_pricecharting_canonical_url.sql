-- Persist the exact PriceCharting canonical product-page URL on the catalog row
-- (one per product, shared by every specimen/certification), so the public-page
-- adapter consumes a STORED url instead of re-deriving a slug from the product
-- name on every request. Populated by a BEFORE trigger on the catalog table, so
-- the existing SECURITY DEFINER confirmation RPCs are NOT modified.

-- Slug helper — mirrors buildGameUrl() in src/lib/pricecharting/webpage/url.ts:
-- lowercase, drop '#', collapse non-alphanumeric runs to a single dash, trim
-- edge dashes. Returns the canonical /game/<console>/<slug> url, or NULL when
-- either part is empty. Pure + immutable + fixed search_path.
create or replace function public.pricecharting_game_url(p_console text, p_name text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when nullif(c, '') is null or nullif(n, '') is null then null
    else 'https://www.pricecharting.com/game/' || c || '/' || n
  end
  from (
    select
      trim(both '-' from regexp_replace(lower(replace(coalesce(p_console, ''), '#', '')), '[^a-z0-9]+', '-', 'g')) as c,
      trim(both '-' from regexp_replace(lower(replace(coalesce(p_name, ''),    '#', '')), '[^a-z0-9]+', '-', 'g')) as n
  ) s;
$$;

alter table public.pricecharting_products
  add column if not exists canonical_url text;

-- Populate canonical_url at link/refresh time (only when not already set, so an
-- authoritative value supplied later is never overwritten by the derivation).
create or replace function public.set_pricecharting_canonical_url()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.canonical_url is null then
    new.canonical_url := public.pricecharting_game_url(new.console_name, new.product_name);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pricecharting_canonical_url on public.pricecharting_products;
create trigger trg_pricecharting_canonical_url
  before insert or update on public.pricecharting_products
  for each row execute function public.set_pricecharting_canonical_url();

-- Backfill existing catalog rows.
update public.pricecharting_products
  set canonical_url = public.pricecharting_game_url(console_name, product_name)
  where canonical_url is null;
