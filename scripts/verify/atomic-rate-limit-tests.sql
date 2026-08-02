begin;

do $$
declare
  v_search_path text[];
begin
  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'try_rate_limit_consume'
       and p.prosecdef
  ) then
    raise exception 'try_rate_limit_consume must be SECURITY DEFINER';
  end if;

  select p.proconfig
    into v_search_path
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'try_rate_limit_consume';

  if v_search_path is null or not ('search_path=pg_catalog, public' = any (v_search_path)) then
    raise exception 'try_rate_limit_consume must pin search_path to pg_catalog, public';
  end if;

  if has_function_privilege('public', 'public.try_rate_limit_consume(text, text, integer, timestamptz, timestamptz)', 'execute') then
    raise exception 'PUBLIC must not execute try_rate_limit_consume';
  end if;
  if has_function_privilege('anon', 'public.try_rate_limit_consume(text, text, integer, timestamptz, timestamptz)', 'execute') then
    raise exception 'anon must not execute try_rate_limit_consume';
  end if;
  if has_function_privilege('authenticated', 'public.try_rate_limit_consume(text, text, integer, timestamptz, timestamptz)', 'execute') then
    raise exception 'authenticated must not execute try_rate_limit_consume';
  end if;
  if not has_function_privilege('service_role', 'public.try_rate_limit_consume(text, text, integer, timestamptz, timestamptz)', 'execute') then
    raise exception 'service_role must execute try_rate_limit_consume';
  end if;
end
$$;

do $$
declare
  v_code text;
begin
  begin
    perform public.try_rate_limit_consume('', 'hash', 1, now() - interval '1 minute', now());
    raise exception 'empty bucket should have been rejected';
  exception
    when sqlstate '22023' then
      null;
  end;

  begin
    perform public.try_rate_limit_consume('contact', '', 1, now() - interval '1 minute', now());
    raise exception 'empty key hash should have been rejected';
  exception
    when sqlstate '22023' then
      null;
  end;

  begin
    perform public.try_rate_limit_consume('contact', 'hash', 0, now() - interval '1 minute', now());
    raise exception 'non-positive max should have been rejected';
  exception
    when sqlstate '22023' then
      null;
  end;

  begin
    perform public.try_rate_limit_consume('contact', 'hash', 1, now(), now() - interval '1 minute');
    raise exception 'reversed timestamps should have been rejected';
  exception
    when sqlstate '22023' then
      null;
  end;

  begin
    perform public.try_rate_limit_consume('contact', 'hash', 1, now() - interval '2 day', now());
    raise exception 'oversized window should have been rejected';
  exception
    when sqlstate '22023' then
      null;
  end;
end
$$;

truncate table public.rate_limit_hits;

do $$
declare
  v_allowed boolean;
begin
  v_allowed := public.try_rate_limit_consume(
    'contact',
    '0123456789abcdef0123456789abcdef01234567',
    1,
    now() - interval '1 minute',
    now()
  );
  if not v_allowed then
    raise exception 'first consume should have succeeded';
  end if;

  v_allowed := public.try_rate_limit_consume(
    'contact',
    '0123456789abcdef0123456789abcdef01234567',
    1,
    now() - interval '1 minute',
    now()
  );
  if v_allowed then
    raise exception 'second consume should have been denied';
  end if;
end
$$;

truncate table public.rate_limit_hits;

insert into public.rate_limit_hits (bucket, key_hash, created_at)
values ('contact', 'fedcba9876543210fedcba9876543210fedcba98', now() - interval '10 seconds');

rollback;
