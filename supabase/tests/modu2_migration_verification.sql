-- Run only against the new MODU2 Supabase project after applying its migration.
-- Everything is inside a transaction and rolled back at the end.
begin;

-- A transaction-local UUID keeps fixtures unique and lets role-scoped checks
-- identify them through public tables without accessing temporary tables.
select set_config('modu2.verification_token', gen_random_uuid()::text, true);

do $$
declare
  v_role text;
  v_table text;
  v_privilege text;
  v_write_privilege text;
  v_function regprocedure;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_table in array array['public.learning_set', 'public.flashcard'] loop
      foreach v_privilege in array array['INSERT', 'UPDATE', 'DELETE'] loop
        if has_table_privilege(v_role, v_table, v_privilege) then
          raise exception '% unexpectedly has % on %', v_role, v_privilege, v_table;
        end if;
      end loop;
      if not has_table_privilege(v_role, v_table, 'SELECT') then
        raise exception '% is missing SELECT on %', v_role, v_table;
      end if;
    end loop;
  end loop;

  foreach v_function in array array[
    'public.complete_learning_set(uuid,text,jsonb)'::regprocedure,
    'public.search_completed_learning_sets(text,integer)'::regprocedure,
    'public.is_valid_flashcard_values(jsonb)'::regprocedure,
    'public.trim_flashcard_text(text)'::regprocedure
  ] loop
    if has_function_privilege('anon', v_function::oid, 'EXECUTE') then
      raise exception 'anon unexpectedly has EXECUTE on %', v_function;
    end if;
    if has_function_privilege('authenticated', v_function::oid, 'EXECUTE') then
      raise exception 'authenticated unexpectedly has EXECUTE on %', v_function;
    end if;
    if not has_function_privilege('service_role', v_function::oid, 'EXECUTE') then
      raise exception 'service_role is missing EXECUTE on %', v_function;
    end if;
  end loop;

  foreach v_table in array array['public.learning_set', 'public.flashcard'] loop
    foreach v_write_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', v_table, v_write_privilege) then
        raise exception 'service_role is missing % on %', v_write_privilege, v_table;
      end if;
    end loop;
  end loop;
end;
$$;

with fixtures(label, status, suffix) as (
  values
    ('percent', 'COMPLETED', '%marker'),
    ('underscore', 'COMPLETED', '_marker'),
    ('backslash', 'COMPLETED', chr(92) || 'marker'),
    ('decoy', 'COMPLETED', 'plain-marker'),
    ('hidden-generating', 'GENERATING', 'hidden-generating'),
    ('hidden-failed', 'FAILED', 'hidden-failed'),
    ('atomic-failure', 'GENERATING', 'atomic-failure'),
    ('atomic-success', 'GENERATING', 'atomic-success')
), test_token as (
  select current_setting('modu2.verification_token') as token
), inserted as (
  insert into public.learning_set (
    title, original_request, selected_topic, learning_goal, status, client_request_id
  )
  select
    'MODU2_VERIFY:' || test_token.token || ':' || fixtures.label,
    'MODU2_VERIFY:' || test_token.token || ':' || fixtures.suffix,
    'verification topic',
    'verification goal',
    fixtures.status,
    gen_random_uuid()
  from fixtures
  cross join test_token
  returning id, title
)
select id, title from inserted;

insert into public.flashcard (learning_set_id, key_text, "values", sort_order)
select
  ls.id,
  'verification-' || split_part(ls.title, ':', 3),
  jsonb_build_array('verification card'),
  1
from public.learning_set ls
where ls.title like 'MODU2_VERIFY:' || current_setting('modu2.verification_token') || ':%'
  and split_part(ls.title, ':', 3) in (
    'percent', 'underscore', 'backslash', 'decoy', 'hidden-generating', 'hidden-failed'
  );

do $$
declare
  v_token text;
  v_count integer;
  v_id uuid;
  v_message text;
  v_expected_message text;
  v_case text;
  v_invalid_cards jsonb;
begin
  v_token := current_setting('modu2.verification_token');

  if public.is_valid_flashcard_values(null) is distinct from false
    or public.is_valid_flashcard_values('null'::jsonb) is distinct from false
    or public.is_valid_flashcard_values('[]'::jsonb) is distinct from false
    or public.is_valid_flashcard_values('[" "]'::jsonb) is distinct from false
    or public.is_valid_flashcard_values('[1]'::jsonb) is distinct from false
    or public.is_valid_flashcard_values('["one","two","three","four","five","six","seven"]'::jsonb) is distinct from false
    or public.is_valid_flashcard_values(('[' || to_json(repeat('x', 501))::text || ']')::jsonb) is distinct from false
    or public.is_valid_flashcard_values('["one","two"]'::jsonb) is distinct from true
    or public.is_valid_flashcard_values(('[' || to_json(' ' || repeat('x', 500) || ' ')::text || ']')::jsonb) is distinct from true then
    raise exception 'flashcard values helper does not match the application schema';
  end if;
  if public.trim_flashcard_text(chr(160)) <> ''
    or public.trim_flashcard_text(chr(65279)) <> '' then
    raise exception 'flashcard text trimming does not match JavaScript trim';
  end if;

  select count(*) into v_count
  from public.search_completed_learning_sets('MODU2_VERIFY:' || v_token || ':%', 5);
  if v_count <> 1 then
    raise exception 'literal percent search returned % rows; expected 1', v_count;
  end if;

  select count(*) into v_count
  from public.search_completed_learning_sets('MODU2_VERIFY:' || v_token || ':_', 5);
  if v_count <> 1 then
    raise exception 'literal underscore search returned % rows; expected 1', v_count;
  end if;

  select count(*) into v_count
  from public.search_completed_learning_sets('MODU2_VERIFY:' || v_token || ':' || chr(92), 5);
  if v_count <> 1 then
    raise exception 'literal backslash search returned % rows; expected 1', v_count;
  end if;

  select id into v_id
  from public.learning_set
  where title = 'MODU2_VERIFY:' || v_token || ':atomic-failure';
  foreach v_case in array array['sql-null', 'json-null', 'object', 'nine', 'eleven'] loop
    v_message := null;
    v_expected_message := case v_case
      when 'sql-null' then 'p_cards must not be SQL NULL'
      when 'json-null' then 'p_cards must be a JSON array'
      when 'object' then 'p_cards must be a JSON array'
      else 'exactly 10 cards are required'
    end;
    begin
      case v_case
        when 'sql-null' then
          perform public.complete_learning_set(v_id, 'bad input', null::jsonb);
        when 'json-null' then
          perform public.complete_learning_set(v_id, 'bad input', 'null'::jsonb);
        when 'object' then
          perform public.complete_learning_set(v_id, 'bad input', '{}'::jsonb);
        when 'nine' then
          select jsonb_agg(jsonb_build_object(
            'key_text', 'invalid-nine-' || n,
            'values', jsonb_build_array('value'),
            'sort_order', n
          ) order by n) into v_invalid_cards from generate_series(1, 9) as series(n);
          perform public.complete_learning_set(v_id, 'bad input', v_invalid_cards);
        when 'eleven' then
          select jsonb_agg(jsonb_build_object(
            'key_text', 'invalid-eleven-' || n,
            'values', jsonb_build_array('value'),
            'sort_order', n
          ) order by n) into v_invalid_cards from generate_series(1, 11) as series(n);
          perform public.complete_learning_set(v_id, 'bad input', v_invalid_cards);
      end case;
    exception when others then
      get stacked diagnostics v_message = message_text;
    end;

    if v_message is distinct from v_expected_message then
      raise exception 'p_cards case % returned %, expected %', v_case, v_message, v_expected_message;
    end if;
    if (select status from public.learning_set where id = v_id) <> 'GENERATING'
      or (select count(*) from public.flashcard where learning_set_id = v_id) <> 0 then
      raise exception 'invalid p_cards case % changed the set or inserted cards', v_case;
    end if;
  end loop;

  -- The ten card inserts happen first, then NULL violates learning_set.title.
  -- The function error must roll back those inserts and leave status unchanged.
  begin
    perform public.complete_learning_set(
      v_id,
      null,
      (select jsonb_agg(jsonb_build_object(
        'key_text', 'atomic-failure-' || n,
        'values', jsonb_build_array('value ' || n),
        'sort_order', n
      ) order by n) from generate_series(1, 10) as series(n))
    );
    raise exception 'expected completion to fail when title is NULL';
  exception
    when not_null_violation then null;
  end;

  if (select status from public.learning_set where id = v_id) <> 'GENERATING'
    or (select count(*) from public.flashcard where learning_set_id = v_id) <> 0 then
    raise exception 'failed completion left partial cards or changed the status';
  end if;

  select id into v_id
  from public.learning_set
  where title = 'MODU2_VERIFY:' || v_token || ':atomic-success';
  perform public.complete_learning_set(
    v_id,
    'atomic success',
    (select jsonb_agg(jsonb_build_object(
      'key_text', 'atomic-success-' || n,
      'values', jsonb_build_array('value ' || n),
      'sort_order', n
    ) order by n) from generate_series(1, 10) as series(n))
  );

  if (select status from public.learning_set where id = v_id) <> 'COMPLETED'
    or (select count(*) from public.flashcard where learning_set_id = v_id) <> 10
    or (select count(distinct sort_order) from public.flashcard where learning_set_id = v_id) <> 10
    or (select min(sort_order) from public.flashcard where learning_set_id = v_id) <> 1
    or (select max(sort_order) from public.flashcard where learning_set_id = v_id) <> 10 then
    raise exception 'successful completion did not store ten ordered cards atomically';
  end if;
end;
$$;

set local role anon;
do $$
declare
  v_sets integer;
  v_cards integer;
  v_token text;
begin
  if current_user <> 'anon' then
    raise exception 'expected current_user anon after SET LOCAL ROLE, got %', current_user;
  end if;

  v_token := current_setting('modu2.verification_token');

  select count(*) into v_sets
  from public.learning_set ls
  where ls.title like 'MODU2_VERIFY:' || v_token || ':%';
  select count(*) into v_cards
  from public.flashcard f
  join public.learning_set ls on ls.id = f.learning_set_id
  where ls.title like 'MODU2_VERIFY:' || v_token || ':%';
  if v_sets <> 4 or v_cards <> 4 then
    raise exception 'anon can see % sets and % cards; expected four visible test sets and four cards', v_sets, v_cards;
  end if;
  if exists (
    select 1 from public.learning_set ls
    where ls.title like 'MODU2_VERIFY:' || v_token || ':%'
      and ls.status in ('GENERATING', 'FAILED')
  ) then
    raise exception 'anon can see a GENERATING or FAILED set';
  end if;
  if exists (
    select 1
    from public.flashcard f
    join public.learning_set ls on ls.id = f.learning_set_id
    where ls.title like 'MODU2_VERIFY:' || v_token || ':%'
      and ls.status in ('GENERATING', 'FAILED')
  ) then
    raise exception 'anon can see cards from a GENERATING or FAILED set';
  end if;
end;
$$;

reset role;
do $$
begin
  if current_user <> session_user then
    raise exception 'RESET ROLE did not restore session_user; current_user is %', current_user;
  end if;
end;
$$;

set local role authenticated;
do $$
declare
  v_sets integer;
  v_cards integer;
  v_token text;
begin
  if current_user <> 'authenticated' then
    raise exception 'expected current_user authenticated after SET LOCAL ROLE, got %', current_user;
  end if;

  v_token := current_setting('modu2.verification_token');

  select count(*) into v_sets
  from public.learning_set ls
  where ls.title like 'MODU2_VERIFY:' || v_token || ':%';
  select count(*) into v_cards
  from public.flashcard f
  join public.learning_set ls on ls.id = f.learning_set_id
  where ls.title like 'MODU2_VERIFY:' || v_token || ':%';
  if v_sets <> 4 or v_cards <> 4 then
    raise exception 'authenticated can see % sets and % cards; expected four visible test sets and four cards', v_sets, v_cards;
  end if;
  if exists (
    select 1 from public.learning_set ls
    where ls.title like 'MODU2_VERIFY:' || v_token || ':%'
      and ls.status in ('GENERATING', 'FAILED')
  ) then
    raise exception 'authenticated can see a GENERATING or FAILED set';
  end if;
  if exists (
    select 1
    from public.flashcard f
    join public.learning_set ls on ls.id = f.learning_set_id
    where ls.title like 'MODU2_VERIFY:' || v_token || ':%'
      and ls.status in ('GENERATING', 'FAILED')
  ) then
    raise exception 'authenticated can see cards from a GENERATING or FAILED set';
  end if;
end;
$$;

reset role;
do $$
begin
  if current_user <> session_user then
    raise exception 'RESET ROLE did not restore session_user; current_user is %', current_user;
  end if;
end;
$$;

rollback;
