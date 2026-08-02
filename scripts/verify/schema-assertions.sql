-- Schema-property assertions for the clean-installed canonical schema.
-- RAISEs (nonzero via ON_ERROR_STOP) on any unmet assertion — never skips.
\set ON_ERROR_STOP on
do $$
declare bad int; offenders text;
begin
  -- 1. every SECURITY DEFINER function pins search_path
  select count(*) into bad
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname in ('public','private') and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%');
  if bad <> 0 then raise exception 'ASSERT FAIL: % SECURITY DEFINER function(s) without pinned search_path', bad; end if;

  -- 2. no public table has RLS disabled
  select count(*), coalesce(string_agg(tablename,', '),'') into bad, offenders
    from pg_tables where schemaname='public' and not rowsecurity;
  if bad <> 0 then raise exception 'ASSERT FAIL: public tables without RLS: %', offenders; end if;

  -- 3. no private table has RLS disabled
  select count(*), coalesce(string_agg(tablename,', '),'') into bad, offenders
    from pg_tables where schemaname='private' and not rowsecurity;
  if bad <> 0 then raise exception 'ASSERT FAIL: private tables without RLS: %', offenders; end if;

  -- 4. required authority + account-deletion objects exist
  if (select count(*) from pg_proc where proname='is_admin')=0 then raise exception 'ASSERT FAIL: is_admin missing'; end if;
  if (select count(*) from pg_proc where proname='purge_customer_account_data')=0 then raise exception 'ASSERT FAIL: purge_customer_account_data missing'; end if;

  raise notice 'SCHEMA ASSERTIONS PASS: 0 definer-without-search_path; all public+private tables RLS-on; is_admin + purge_customer_account_data present';
end $$;
