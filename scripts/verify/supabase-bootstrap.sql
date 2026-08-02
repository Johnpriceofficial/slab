-- ==========================================================================
-- Supabase-compatible environment bootstrap for DISPOSABLE migration testing.
-- Recreates only the platform objects the slab migrations depend on (proven by
-- static analysis: auth.users/uid/role, storage.objects/buckets/foldername,
-- the four Supabase roles; no vault, no pg_net, no custom extensions).
--
-- This mirrors what `supabase db reset` provisions before applying
-- supabase/migrations. It contains NO customer data and NO secrets.
-- ==========================================================================

-- ---- Roles (Supabase standard) -------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator noinherit login; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_admin') then create role supabase_admin login createrole createdb replication bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin login createrole noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_storage_admin') then create role supabase_storage_admin login createrole noinherit bypassrls; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role, supabase_auth_admin, supabase_storage_admin to postgres;

-- ---- Extensions commonly present in the Supabase base image ---------------
create extension if not exists pgcrypto with schema public;
create extension if not exists "uuid-ossp" with schema public;

-- ---- auth schema ----------------------------------------------------------
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role, postgres;

create table if not exists auth.users (
  instance_id uuid,
  id uuid not null primary key default gen_random_uuid(),
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  is_super_admin boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  phone text,
  confirmed_at timestamptz,
  banned_until timestamptz,
  deleted_at timestamptz
);
grant select on auth.users to postgres, service_role;

-- auth.* helpers read the request GUCs, exactly like Supabase's real ones.
create or replace function auth.uid() returns uuid language sql stable
  as $$ select coalesce(
                 nullif(current_setting('request.jwt.claim.sub', true), ''),
                 nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
               )::uuid $$;
create or replace function auth.role() returns text language sql stable
  as $$ select coalesce(
                 nullif(current_setting('request.jwt.claim.role', true), ''),
                 nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
               ) $$;
create or replace function auth.email() returns text language sql stable
  as $$ select coalesce(
                 nullif(current_setting('request.jwt.claim.email', true), ''),
                 nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
               ) $$;
create or replace function auth.jwt() returns jsonb language sql stable
  as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt() to anon, authenticated, service_role, postgres;

-- ---- storage schema -------------------------------------------------------
create schema if not exists storage authorization supabase_storage_admin;
grant usage on schema storage to anon, authenticated, service_role, postgres;

create table if not exists storage.buckets (
  id text not null primary key,
  name text not null,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner_id text
);
create table if not exists storage.objects (
  id uuid not null primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  owner_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata jsonb,
  path_tokens text[],
  version text,
  user_metadata jsonb
);
grant all on storage.buckets, storage.objects to postgres, service_role;

-- storage.foldername(name) -> text[] of the path segments except the file.
create or replace function storage.foldername(name text) returns text[] language plpgsql immutable
  as $$ declare parts text[]; begin parts := string_to_array(name, '/'); return parts[1:array_length(parts,1)-1]; end $$;
create or replace function storage.filename(name text) returns text language plpgsql immutable
  as $$ declare parts text[]; begin parts := string_to_array(name, '/'); return parts[array_length(parts,1)]; end $$;
grant execute on function storage.foldername(text), storage.filename(text) to anon, authenticated, service_role, postgres;

-- ---- supported-deployment ledger (mirrors supabase_migrations) ------------
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);

select 'bootstrap complete' as status;
