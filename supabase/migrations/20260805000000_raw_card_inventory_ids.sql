-- ============================================================================
-- GradedCardValue.com — raw-card public inventory identifiers (R0001…).
--
-- Applies the SAME proven public-ID system that slabs use (20260804000000) to
-- the raw-card inventory in public.cards, using the raw_public_seq created
-- there. Raw cards get "R0001, R0002, …"; slabs keep "S0001, …". Codes are
-- permanent, never reused, immutable, ≥4 digits, and searchable.
--
-- Raw cards are scan-sourced (cards.source_scan_id is required and inserts run
-- through the service-role scan-card Edge Function), so assignment is done by a
-- BEFORE INSERT trigger rather than a create RPC — every insert path gets a
-- code with no Edge Function change. The slab numbering system is NOT touched.
-- ============================================================================

-- ── 1. Public identifier columns on cards ──────────────────────────────────
alter table public.cards
  add column if not exists inventory_prefix text not null default 'R',
  add column if not exists inventory_sequence integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cards_inventory_prefix_chk') then
    alter table public.cards add constraint cards_inventory_prefix_chk check (inventory_prefix ~ '^[A-Z]$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cards_inventory_sequence_positive') then
    alter table public.cards add constraint cards_inventory_sequence_positive check (inventory_sequence is null or inventory_sequence >= 1);
  end if;
end $$;

alter table public.cards
  add column if not exists inventory_code text
    generated always as (inventory_prefix || lpad(inventory_sequence::text, 4, '0')) stored;

-- ── 2. Deterministic backfill (by creation order) ──────────────────────────
with ordered as (
  select id, row_number() over (order by created_at asc, id asc) as seq
  from public.cards
)
update public.cards c
   set inventory_prefix = 'R',
       inventory_sequence = o.seq
  from ordered o
 where o.id = c.id
   and c.inventory_sequence is null;

select setval(
  'public.raw_public_seq',
  coalesce((select max(inventory_sequence) from public.cards where inventory_prefix = 'R'), 0) + 1,
  false
);

-- ── 3. Server-side assignment for every future insert ──────────────────────
-- Cards are inserted by the service-role scanner; a BEFORE INSERT trigger gives
-- each new row a permanent R-sequence without the Edge Function supplying one.
create or replace function public.assign_raw_card_inventory()
returns trigger
language plpgsql
as $$
begin
  if new.inventory_sequence is null then
    new.inventory_prefix := 'R';
    new.inventory_sequence := nextval('public.raw_public_seq');
  end if;
  return new;
end;
$$;

drop trigger if exists cards_assign_inventory on public.cards;
create trigger cards_assign_inventory
  before insert on public.cards
  for each row execute function public.assign_raw_card_inventory();

alter table public.cards alter column inventory_sequence set not null;

create unique index if not exists cards_inventory_code_uidx on public.cards (inventory_code);
create unique index if not exists cards_prefix_sequence_uidx on public.cards (inventory_prefix, inventory_sequence);
create index if not exists cards_inventory_sequence_idx on public.cards (inventory_sequence);

-- ── 4. Immutability (reuses the generic slab trigger function) ─────────────
drop trigger if exists cards_inventory_id_immutable on public.cards;
create trigger cards_inventory_id_immutable
  before update on public.cards
  for each row execute function public.enforce_inventory_id_immutable();

-- ── 5. Customer-facing, owner-scoped raw inventory ─────────────────────────
-- Raw-card inventory becomes customer-facing like slabs: an owner reads and
-- updates their own cards (e.g. status/edits from the client); admins see all.
-- Inserts and deletes remain the service-role scanner's responsibility.
drop policy if exists cards_owner_read on public.cards;
drop policy if exists cards_owner_or_admin_read on public.cards;
drop policy if exists cards_owner_or_admin_update on public.cards;

create policy cards_owner_or_admin_read on public.cards
  for select to authenticated
  using (created_by = (select auth.uid()) or public.is_admin((select auth.uid())));

create policy cards_owner_or_admin_update on public.cards
  for update to authenticated
  using (created_by = (select auth.uid()) or public.is_admin((select auth.uid())))
  with check (created_by = (select auth.uid()) or public.is_admin((select auth.uid())));

grant select, update on public.cards to authenticated;

-- ── 6. Unified resolver across both inventories ────────────────────────────
-- resolve_inventory("S0001") -> the slab; ("R0001") -> the raw card;
-- ("0001"/"1") -> both an S and an R with that sequence, if the caller owns
-- them. Ownership is enforced per table (slabs.owner_id, cards.created_by).
create or replace function public.resolve_inventory(p_query text)
returns table (item_type text, id uuid, inventory_code text, inventory_sequence integer)
language sql
stable
security definer
set search_path = public, auth
as $$
  select 'slab'::text, s.id, s.inventory_code, s.inventory_sequence
  from public.slabs s
  join public.parse_inventory_code(p_query) pc
    on s.inventory_sequence = pc.sequence
   and (pc.prefix is null or s.inventory_prefix = pc.prefix)
  where s.owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  union all
  select 'raw_card'::text, c.id, c.inventory_code, c.inventory_sequence
  from public.cards c
  join public.parse_inventory_code(p_query) pc
    on c.inventory_sequence = pc.sequence
   and (pc.prefix is null or c.inventory_prefix = pc.prefix)
  where c.created_by = (select auth.uid()) or public.is_admin((select auth.uid()));
$$;

revoke all on function public.resolve_inventory(text) from public, anon;
grant execute on function public.resolve_inventory(text) to authenticated, service_role;

comment on column public.cards.inventory_code is 'Permanent public raw-card identifier (e.g. R0001). Immutable, never reused.';
comment on function public.resolve_inventory(text) is 'Resolve S/R codes or a bare sequence to the accessible slab(s) and raw card(s).';
