-- ============================================================================
-- PR C.7: a legitimate, stored game/franchise value for each slab (e.g.
-- "Pokemon", "Magic: The Gathering", "One Piece"). The eBay listing title needs
-- this to lead with the franchise; it must be a real field, never a hard-coded
-- global. Nullable + additive: existing rows and create_slab are unaffected
-- (create_slab leaves it null; operators/AI set it through the normal edit path).
-- ============================================================================

alter table public.slabs
  add column if not exists game_or_franchise text;

comment on column public.slabs.game_or_franchise is
  'Trading-card game / franchise (e.g. Pokemon, Magic: The Gathering). Nullable; set via edit/AI, never hard-coded. Used to lead the eBay listing title.';
