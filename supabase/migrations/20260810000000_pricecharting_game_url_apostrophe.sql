-- Canonical-URL construction must PRESERVE apostrophes, matching PriceCharting's
-- real slugs. "N's Zoroark ex #112" is served at .../n's-zoroark-ex-112 (rendered
-- n%27s-...), NOT .../n-s-... . The prior slug helper collapsed the apostrophe to
-- a dash, producing a URL that does not resolve. This mirrors the buildGameUrl()
-- fix in src/lib/pricecharting/webpage/url.ts: normalize curly (’) and
-- percent-encoded (%27) apostrophes to a straight apostrophe and KEEP it; collapse
-- every other non-alphanumeric run to a single dash; trim edge dashes.
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
      trim(both '-' from regexp_replace(
        replace(replace(replace(lower(coalesce(p_console, '')), '’', ''''), '%27', ''''), '#', ''),
        '[^a-z0-9'']+', '-', 'g')) as c,
      trim(both '-' from regexp_replace(
        replace(replace(replace(lower(coalesce(p_name, '')), '’', ''''), '%27', ''''), '#', ''),
        '[^a-z0-9'']+', '-', 'g')) as n
  ) s;
$$;

-- Re-derive canonical_url ONLY for catalog rows whose name contains an apostrophe
-- variant AND whose stored URL was the (now-fixed) auto-derived value — i.e. it
-- differs from the corrected derivation. This repairs apostrophe products without
-- overwriting any URL that already matches the corrected slug.
update public.pricecharting_products p
set canonical_url = public.pricecharting_game_url(p.console_name, p.product_name)
where (p.product_name ~ '[’''%]' or p.console_name ~ '[’''%]')
  and p.canonical_url is distinct from public.pricecharting_game_url(p.console_name, p.product_name);
