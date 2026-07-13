-- CGC Population Report integration (optional provider). Purely ADDITIVE.
--
-- Population data describes SCARCITY only. It is deliberately separate from
-- pricing, sold comps, identity confidence, certification verification, and
-- valuation confidence. Nothing here changes any existing value.
--
-- Trust model (single-admin app): population tables are shared REFERENCE data —
-- admins may READ them; only the trusted server (service-role edge function)
-- may WRITE (import) them, so there is no client-side write policy. Slabs keep
-- their existing admin-only RLS; the new linkage columns ride on that.

-- ─── sets: one row per CGC population-report set we have indexed ─────────────
create table if not exists public.cgc_population_sets (
  id                  uuid primary key default gen_random_uuid(),
  cgc_set_id          bigint,
  category            text,
  subcategory         text,
  brand               text,
  year                text,
  set_name            text,
  normalized_set_name text,
  report_url          text,
  last_apify_run_id   text,
  last_dataset_id     text,
  last_refreshed_at   timestamptz,
  refresh_status      text,  -- queued | running | succeeded | failed | timed_out | aborted
  refresh_error       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Stable identity: the CGC set id when known, else the operator-approved report
-- URL, else a normalized set name. Partial uniques so nulls don't collide.
create unique index if not exists cgc_pop_sets_cgc_set_id_uidx
  on public.cgc_population_sets (cgc_set_id) where cgc_set_id is not null;
create unique index if not exists cgc_pop_sets_report_url_uidx
  on public.cgc_population_sets (report_url) where report_url is not null;
create index if not exists cgc_pop_sets_norm_name_idx
  on public.cgc_population_sets (normalized_set_name);

-- ─── cards: one row per card variant in an indexed set ──────────────────────
create table if not exists public.cgc_population_cards (
  id                     uuid primary key default gen_random_uuid(),
  population_set_id      uuid references public.cgc_population_sets(id) on delete cascade,
  cgc_card_id            bigint,
  card_name              text,
  normalized_card_name   text,
  card_number            text,
  normalized_card_number text,
  parallel_or_variant    text,
  normalized_variant     text,
  autograph              boolean,
  memorabilia            boolean,
  total_graded           integer,
  count_perfect_10       integer,
  count_pristine_10      integer,
  count_gem_mint_10      integer,
  count_mint_plus_9_5    integer,
  count_mint_9           integer,
  count_nm_mint_plus_8_5 integer,
  count_nm_mint_8        integer,
  count_nm_plus_7_5      integer,
  count_nm_7             integer,
  count_ex_nm_plus_6_5   integer,
  count_ex_nm_6          integer,
  count_lower_grades     integer,
  count_aa               integer,
  count_au               integer,
  report_url             text,
  raw_record             jsonb,
  source_retrieved_at    timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- Counts are nonnegative when present. NULL means "not reported" (missing is
  -- NOT a claimed zero); coalesce(...,0) lets null pass, a negative value fails.
  constraint cgc_pop_cards_nonneg check (
    coalesce(total_graded, 0)           >= 0 and
    coalesce(count_perfect_10, 0)       >= 0 and
    coalesce(count_pristine_10, 0)      >= 0 and
    coalesce(count_gem_mint_10, 0)      >= 0 and
    coalesce(count_mint_plus_9_5, 0)    >= 0 and
    coalesce(count_mint_9, 0)           >= 0 and
    coalesce(count_nm_mint_plus_8_5, 0) >= 0 and
    coalesce(count_nm_mint_8, 0)        >= 0 and
    coalesce(count_nm_plus_7_5, 0)      >= 0 and
    coalesce(count_nm_7, 0)             >= 0 and
    coalesce(count_ex_nm_plus_6_5, 0)   >= 0 and
    coalesce(count_ex_nm_6, 0)          >= 0 and
    coalesce(count_lower_grades, 0)     >= 0 and
    coalesce(count_aa, 0)               >= 0 and
    coalesce(count_au, 0)               >= 0
  )
);

create unique index if not exists cgc_pop_cards_cgc_card_id_uidx
  on public.cgc_population_cards (cgc_card_id) where cgc_card_id is not null;
create index if not exists cgc_pop_cards_set_idx          on public.cgc_population_cards (population_set_id);
create index if not exists cgc_pop_cards_norm_name_idx     on public.cgc_population_cards (normalized_card_name);
create index if not exists cgc_pop_cards_norm_number_idx   on public.cgc_population_cards (normalized_card_number);

-- ─── import runs: audit + async status of every Apify actor run ─────────────
create table if not exists public.cgc_population_import_runs (
  id           uuid primary key default gen_random_uuid(),
  requested_by uuid references auth.users(id) on delete set null,
  set_id       uuid references public.cgc_population_sets(id) on delete set null,
  apify_run_id text unique,
  dataset_id   text,
  mode         text,
  input        jsonb,
  status       text not null default 'queued', -- queued|running|succeeded|failed|timed_out|aborted
  item_count   integer,
  error        text,
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists cgc_pop_runs_set_idx    on public.cgc_population_import_runs (set_id);
create index if not exists cgc_pop_runs_status_idx on public.cgc_population_import_runs (status);

-- ─── slab linkage (nullable, additive) ──────────────────────────────────────
alter table public.slabs
  add column if not exists cgc_population_card_id         uuid references public.cgc_population_cards(id) on delete set null,
  add column if not exists cgc_population_match_status    text,
  add column if not exists cgc_population_match_confidence integer,
  add column if not exists cgc_population_matched_at       timestamptz,
  add column if not exists cgc_population_match_method     text,
  add column if not exists cgc_population_snapshot         jsonb;

-- ─── updated_at triggers (reuse the existing generic setter) ────────────────
drop trigger if exists cgc_pop_sets_set_updated_at on public.cgc_population_sets;
create trigger cgc_pop_sets_set_updated_at before update on public.cgc_population_sets
  for each row execute function public.slab_set_updated_at();
drop trigger if exists cgc_pop_cards_set_updated_at on public.cgc_population_cards;
create trigger cgc_pop_cards_set_updated_at before update on public.cgc_population_cards
  for each row execute function public.slab_set_updated_at();

-- ─── RLS: admins READ; only the service-role edge function WRITES ───────────
alter table public.cgc_population_sets        enable row level security;
alter table public.cgc_population_cards       enable row level security;
alter table public.cgc_population_import_runs enable row level security;

drop policy if exists "cgc_pop_sets admin read"  on public.cgc_population_sets;
create policy "cgc_pop_sets admin read"  on public.cgc_population_sets
  for select to authenticated using (public.is_admin(auth.uid()));
drop policy if exists "cgc_pop_cards admin read" on public.cgc_population_cards;
create policy "cgc_pop_cards admin read" on public.cgc_population_cards
  for select to authenticated using (public.is_admin(auth.uid()));
drop policy if exists "cgc_pop_runs admin read"  on public.cgc_population_import_runs;
create policy "cgc_pop_runs admin read"  on public.cgc_population_import_runs
  for select to authenticated using (public.is_admin(auth.uid()));
-- No INSERT/UPDATE/DELETE policy on purpose: population writes happen only under
-- the service role (RLS-bypassing) inside the trusted edge function.

grant select on public.cgc_population_sets, public.cgc_population_cards, public.cgc_population_import_runs to authenticated;

-- ─── atomic claim of an import slot (cost/abuse control) ─────────────────────
-- One active run per set + a configurable refresh lock. Advisory lock serializes
-- concurrent claims on the same set. Raises when a run is already active or the
-- set was refreshed within the lock window. Admin-gated on the PASSED user id
-- (the edge function runs as service role, so auth.uid() is null here).
create or replace function public.cgc_claim_import_run(
  p_requested_by uuid,
  p_set_id       uuid,
  p_mode         text,
  p_input        jsonb,
  p_min_hours    numeric default 24
) returns public.cgc_population_import_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run        public.cgc_population_import_runs;
  v_last       timestamptz;
  v_active     integer;
begin
  if not public.is_admin(p_requested_by) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  -- Serialize claims for this set (hash the uuid text to a lock key).
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_set_id::text, p_input::text), 0));

  if p_set_id is not null then
    select count(*) into v_active
    from public.cgc_population_import_runs
    where set_id = p_set_id and status in ('queued', 'running');
    if v_active > 0 then
      raise exception 'ACTIVE_RUN_EXISTS' using errcode = '55000';
    end if;

    select last_refreshed_at into v_last from public.cgc_population_sets where id = p_set_id;
    if v_last is not null and v_last > now() - make_interval(hours => greatest(p_min_hours, 0)) then
      raise exception 'REFRESH_LOCKED' using errcode = '55000', detail = v_last::text;
    end if;

    update public.cgc_population_sets set refresh_status = 'queued' where id = p_set_id;
  end if;

  insert into public.cgc_population_import_runs (requested_by, set_id, mode, input, status, started_at)
  values (p_requested_by, p_set_id, p_mode, p_input, 'queued', now())
  returning * into v_run;
  return v_run;
end;
$$;

grant execute on function public.cgc_claim_import_run(uuid, uuid, text, jsonb, numeric) to authenticated;
