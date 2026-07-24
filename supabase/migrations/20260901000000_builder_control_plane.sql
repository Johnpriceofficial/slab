-- ============================================================================
-- AI Build Control Plane — Phase 1 durable spine.
--
-- The immutable audit + workflow state for the internal builder. Every table is
-- ADMIN-READ via RLS (public.is_admin(auth.uid())) and NEVER client-writable: the
-- builder writes only from a service_role backend (Edge Function / orchestrator),
-- so a browser session can inspect runs but can never fabricate an approval or a
-- tool-call record. No table stores a raw secret — connections hold only a
-- provider + scope list + a NAMED reference to a secret held elsewhere, never the
-- token itself; tool-call inputs/results are stored pre-redacted by the app.
--
-- This migration is ADDITIVE (new tables only) and touches nothing existing.
-- ============================================================================

-- ── connections: which provider accounts the builder may use, and at what ceiling.
create table if not exists public.builder_connections (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null check (provider in ('github', 'vercel', 'supabase', 'ebay', 'pricecharting', 'system')),
  label          text not null,
  scopes         text[] not null default '{}',
  -- The MOST permissive risk this connection may ever be used for. A read-only
  -- connection can never be used by a production_write/destructive tool.
  risk_ceiling   text not null default 'read' check (risk_ceiling in ('read', 'preview_write', 'production_write', 'destructive')),
  -- A NAME/reference for the credential (looked up from a secret store at call
  -- time) — never the credential value. Nullable for read-only/public connectors.
  secret_ref     text,
  status         text not null default 'connected' check (status in ('connected', 'revoked', 'error')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── runs: one builder execution (an instruction → plan → gated execution).
create table if not exists public.builder_runs (
  id             uuid primary key default gen_random_uuid(),
  project        text not null,
  environment    text not null default 'development' check (environment in ('development', 'preview', 'production')),
  requested_by   uuid references auth.users (id) on delete set null,
  instruction    text not null,
  status         text not null default 'requested' check (status in (
                   'requested','planned','approved','executing','waiting_for_ci','waiting_for_preview',
                   'waiting_for_approval','deploying','verifying','completed','failed','rolled_back')),
  session_mode   text not null default 'read_only' check (session_mode in ('read_only','allow_preview','allow_all_nondestructive')),
  correlation_id text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists builder_runs_status_idx on public.builder_runs (status, created_at desc);

-- ── steps: the ordered plan items within a run (one per agent/phase).
create table if not exists public.builder_steps (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.builder_runs (id) on delete cascade,
  idx            integer not null,
  agent          text not null,
  title          text not null,
  status         text not null default 'pending' check (status in ('pending','running','done','failed','skipped')),
  created_at     timestamptz not null default now(),
  unique (run_id, idx)
);

-- ── approvals: the human gate. A production_write/destructive tool call cannot
--    execute until a row here is 'approved' (destructive requires confirmation_phrase).
create table if not exists public.builder_approvals (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references public.builder_runs (id) on delete cascade,
  risk                text not null check (risk in ('preview_write','production_write','destructive')),
  requested_action    text not null,
  requested_by        uuid references auth.users (id) on delete set null,
  decided_by          uuid references auth.users (id) on delete set null,
  decision            text not null default 'pending' check (decision in ('pending','approved','rejected')),
  confirmation_phrase text,
  created_at          timestamptz not null default now(),
  decided_at          timestamptz
);
create index if not exists builder_approvals_run_idx on public.builder_approvals (run_id, decision);

-- ── tool_calls: the immutable ledger of every action the plane authorized. Inputs
--    and results are stored ALREADY redacted by the app (jsonb).
create table if not exists public.builder_tool_calls (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.builder_runs (id) on delete cascade,
  step_id         uuid references public.builder_steps (id) on delete set null,
  acting_user     uuid references auth.users (id) on delete set null,
  agent           text not null,
  provider        text not null check (provider in ('github', 'vercel', 'supabase', 'ebay', 'pricecharting', 'system')),
  action          text not null,
  risk            text not null check (risk in ('read','preview_write','production_write','destructive')),
  decision        text not null check (decision in ('auto','session_approval','explicit_approval','typed_confirmation','denied')),
  approval_id     uuid references public.builder_approvals (id) on delete set null,
  sanitized_input  jsonb not null default '{}'::jsonb,
  sanitized_result jsonb,
  commit_sha      text,
  correlation_id  text not null,
  started_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create index if not exists builder_tool_calls_run_idx on public.builder_tool_calls (run_id, started_at desc);

-- ── audit_events: append-only narrative of everything that happened.
create table if not exists public.builder_audit_events (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid references public.builder_runs (id) on delete cascade,
  actor          uuid references auth.users (id) on delete set null,
  event_type     text not null,
  detail         jsonb not null default '{}'::jsonb,
  correlation_id text not null,
  created_at     timestamptz not null default now()
);
create index if not exists builder_audit_events_run_idx on public.builder_audit_events (run_id, created_at desc);

-- ── policy_rules: environment-aware overrides the policy engine consults.
create table if not exists public.builder_policy_rules (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null check (provider in ('github', 'vercel', 'supabase', 'ebay', 'pricecharting', 'system')),
  risk           text not null check (risk in ('read','preview_write','production_write','destructive')),
  environment    text not null check (environment in ('development','preview','production')),
  decision       text not null check (decision in ('auto','session_approval','explicit_approval','typed_confirmation','denied')),
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (provider, risk, environment)
);

-- ── RLS: admins may READ everything; NO ONE writes from a browser. Sensitive writes
--    happen only from a service_role backend (which bypasses RLS).
do $$
declare t text;
begin
  foreach t in array array[
    'builder_connections','builder_runs','builder_steps','builder_approvals',
    'builder_tool_calls','builder_audit_events','builder_policy_rules'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %I on public.%I;', t || '_admin_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_admin(auth.uid()));', t || '_admin_read', t);
    -- Explicitly deny client writes (no insert/update/delete policy exists → denied,
    -- but revoke the table grants too for defense in depth).
    execute format('revoke insert, update, delete on public.%I from anon, authenticated;', t);
  end loop;
end $$;

-- ── SECURITY DEFINER append-audit RPC (service_role only): the checked-write pattern
--    the orchestrator uses to record narrative events. Detail is expected pre-redacted.
create or replace function public.builder_append_audit_event(
  p_run_id uuid, p_actor uuid, p_event_type text, p_detail jsonb, p_correlation_id text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  insert into public.builder_audit_events (run_id, actor, event_type, detail, correlation_id)
  values (p_run_id, p_actor, p_event_type, coalesce(p_detail, '{}'::jsonb), p_correlation_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.builder_append_audit_event(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.builder_append_audit_event(uuid, uuid, text, jsonb, text) to service_role;
