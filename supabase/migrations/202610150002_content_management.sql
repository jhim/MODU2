-- MODU2 incremental content management and ownership migration.
-- Apply only after 202610150001_init_modu2.sql on the MODU2 Supabase project.
alter table public.learning_set
  add column if not exists owner_id uuid references auth.users(id) on delete set null,
  add column if not exists source_mode text not null default 'AI';
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.learning_set'::regclass and conname = 'learning_set_source_mode_check') then
    alter table public.learning_set add constraint learning_set_source_mode_check
      check (source_mode in ('AI', 'PHOTO', 'TEXT', 'EXCEL'));
  end if;
end;
$$;
-- Keep the existing public completed-content read policy, but do not expose the new owner UUID.
revoke select on table public.learning_set from anon, authenticated;
revoke select (owner_id) on table public.learning_set from anon, authenticated;
grant select (id, title, original_request, selected_topic, learning_goal, status, created_at, updated_at, source_mode)
  on table public.learning_set to anon, authenticated;
create index if not exists learning_set_completed_created_idx on public.learning_set (created_at desc, id) where status = 'COMPLETED';
create index if not exists learning_set_owner_updated_idx on public.learning_set (owner_id, updated_at desc) where status = 'COMPLETED';
-- Keep a private snapshot before each successful edit so an owner can recover a prior revision.
create table if not exists public.learning_set_revision (
  revision_id uuid primary key default gen_random_uuid(),
  learning_set_id uuid not null references public.learning_set(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  source_mode text not null check (source_mode in ('AI', 'PHOTO', 'TEXT', 'EXCEL')),
  cards jsonb not null check (jsonb_typeof(cards) = 'array' and jsonb_array_length(cards) between 1 and 500),
  saved_at timestamptz not null default clock_timestamp()
);
alter table public.learning_set_revision enable row level security;
revoke all on table public.learning_set_revision from public, anon, authenticated;
grant select, insert, update, delete on table public.learning_set_revision to service_role;
create index if not exists learning_set_revision_owner_time_idx
  on public.learning_set_revision (learning_set_id, owner_id, saved_at desc);

create or replace function public.list_learning_sets(
  p_query text default '', p_sort text default 'newest', p_page integer default 1,
  p_page_size integer default 20, p_owner_id uuid default null, p_scope text default 'all'
) returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_result jsonb;
  v_total integer;
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_size integer := greatest(1, least(coalesce(p_page_size, 20), 50));
  v_sort text := case when p_sort = 'name' then 'name' else 'newest' end;
  v_query text := lower(btrim(coalesce(p_query, '')));
begin
  if p_scope is null or p_scope not in ('all', 'mine') then raise exception 'invalid scope'; end if;
  if p_scope = 'mine' and p_owner_id is null then raise exception 'owner required'; end if;
  select count(*)::integer into v_total from public.learning_set ls
  where ls.status = 'COMPLETED' and (p_scope <> 'mine' or ls.owner_id = p_owner_id)
    and (v_query = '' or position(v_query in lower(ls.title || ' ' || ls.original_request)) > 0
      or exists (select 1 from public.flashcard fc where fc.learning_set_id = ls.id
        and position(v_query in lower(fc.key_text || ' ' || coalesce(fc."values"::text, ''))) > 0));
  select coalesce(jsonb_agg(item.row_data order by case when v_sort = 'name' then item.sort_name end asc, case when v_sort = 'newest' then item.sort_created end desc, item.row_id), '[]'::jsonb)
    into v_result
  from (
    select ls.id as row_id, lower(ls.title) as sort_name, ls.created_at as sort_created,
      jsonb_build_object('id', ls.id, 'title', ls.title, 'original_request', ls.original_request,
        'created_at', ls.created_at, 'updated_at', ls.updated_at, 'source_mode', ls.source_mode,
        'card_count', (select count(*)::integer from public.flashcard fc where fc.learning_set_id = ls.id),
        'preview', coalesce((select jsonb_agg(jsonb_build_object('key', sample.key_text, 'values', sample."values") order by sample.sort_order)
          from (select fc.key_text, fc."values", fc.sort_order from public.flashcard fc
            where fc.learning_set_id = ls.id order by fc.sort_order limit 2) sample), '[]'::jsonb),
        'can_edit', p_owner_id is not null and ls.owner_id = p_owner_id) as row_data
    from public.learning_set ls
    where ls.status = 'COMPLETED' and (p_scope <> 'mine' or ls.owner_id = p_owner_id)
      and (v_query = '' or position(v_query in lower(ls.title || ' ' || ls.original_request)) > 0
        or exists (select 1 from public.flashcard fc where fc.learning_set_id = ls.id
          and position(v_query in lower(fc.key_text || ' ' || coalesce(fc."values"::text, ''))) > 0))
    order by case when v_sort = 'name' then lower(ls.title) else '' end asc,
      case when v_sort = 'newest' then ls.created_at end desc, ls.id
    offset (v_page - 1) * v_size limit v_size
  ) item;
  return jsonb_build_object('results', v_result, 'total', v_total, 'page', v_page,
    'page_size', v_size, 'total_pages', greatest(1, ceil(v_total::numeric / v_size)::integer));
end;
$$;

create or replace function public.create_owned_learning_set(p_owner_id uuid, p_title text, p_cards jsonb, p_source_mode text)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare v_set public.learning_set;
begin
  if p_owner_id is null then raise exception 'owner required'; end if;
  if p_title is null or char_length(public.trim_flashcard_text(p_title)) not between 1 and 120 then raise exception 'invalid title'; end if;
  if p_source_mode is null or p_source_mode not in ('AI', 'PHOTO', 'TEXT', 'EXCEL') then raise exception 'invalid source mode'; end if;
  if p_cards is null or jsonb_typeof(p_cards) is distinct from 'array'
     or jsonb_array_length(p_cards) < 1 or jsonb_array_length(p_cards) > 500 then raise exception 'cards must contain 1 to 500 items'; end if;
  if exists (select 1 from jsonb_array_elements(p_cards) as item(card)
    where jsonb_typeof(item.card) is distinct from 'object'
      or item.card->>'key' is null
      or char_length(public.trim_flashcard_text(item.card->>'key')) not between 1 and 120
      or not public.is_valid_flashcard_values(item.card->'values')) then raise exception 'invalid card'; end if;
  if (select count(distinct lower(public.trim_flashcard_text(item.card->>'key')))
      from jsonb_array_elements(p_cards) as item(card)) <> jsonb_array_length(p_cards) then raise exception 'duplicate card key'; end if;
  insert into public.learning_set (title, original_request, selected_topic, learning_goal, status, client_request_id, owner_id, source_mode)
    values (public.trim_flashcard_text(p_title), public.trim_flashcard_text(p_title), public.trim_flashcard_text(p_title),
      '직접 만든 학습 콘텐츠', 'GENERATING', gen_random_uuid(), p_owner_id, p_source_mode) returning * into v_set;
  insert into public.flashcard (learning_set_id, key_text, "values", sort_order)
    select v_set.id, public.trim_flashcard_text(item.card->>'key'), item.card->'values', item.ordinality::integer
    from jsonb_array_elements(p_cards) with ordinality as item(card, ordinality);
  update public.learning_set set status = 'COMPLETED', updated_at = now() where id = v_set.id returning * into v_set;
  return jsonb_build_object('id', v_set.id, 'title', v_set.title, 'original_request', v_set.original_request,
    'selected_topic', v_set.selected_topic, 'learning_goal', v_set.learning_goal, 'status', v_set.status,
    'created_at', v_set.created_at, 'updated_at', v_set.updated_at, 'source_mode', v_set.source_mode,
    'cards', (select jsonb_agg(jsonb_build_object('key', fc.key_text, 'values', fc."values") order by fc.sort_order)
      from public.flashcard fc where fc.learning_set_id = v_set.id));
end;
$$;

create or replace function public.update_owned_learning_set(
  p_owner_id uuid, p_learning_set_id uuid, p_expected_updated_at timestamptz,
  p_title text, p_cards jsonb, p_source_mode text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare v_set public.learning_set;
begin
  select * into v_set from public.learning_set where id = p_learning_set_id
    and owner_id = p_owner_id and status = 'COMPLETED' for update;
  if not found then raise exception 'content not found or not owned' using errcode = 'P0002'; end if;
  if p_expected_updated_at is null or v_set.updated_at <> p_expected_updated_at then raise exception 'content changed since it was loaded' using errcode = '40001'; end if;
  if p_title is null or char_length(public.trim_flashcard_text(p_title)) not between 1 and 120 then raise exception 'invalid title'; end if;
  if p_cards is null or jsonb_typeof(p_cards) is distinct from 'array'
     or jsonb_array_length(p_cards) < 1 or jsonb_array_length(p_cards) > 500 then raise exception 'cards must contain 1 to 500 items'; end if;
  if exists (select 1 from jsonb_array_elements(p_cards) as item(card)
    where jsonb_typeof(item.card) is distinct from 'object'
      or item.card->>'key' is null
      or char_length(public.trim_flashcard_text(item.card->>'key')) not between 1 and 120
      or not public.is_valid_flashcard_values(item.card->'values')) then raise exception 'invalid card'; end if;
  if (select count(distinct lower(public.trim_flashcard_text(item.card->>'key')))
      from jsonb_array_elements(p_cards) as item(card)) <> jsonb_array_length(p_cards) then raise exception 'duplicate card key'; end if;
  if p_source_mode is not null and p_source_mode not in ('AI', 'PHOTO', 'TEXT', 'EXCEL') then raise exception 'invalid source mode'; end if;
  insert into public.learning_set_revision (learning_set_id, owner_id, title, source_mode, cards)
    select v_set.id, v_set.owner_id, v_set.title, v_set.source_mode,
      coalesce(jsonb_agg(jsonb_build_object('key', fc.key_text, 'values', fc."values") order by fc.sort_order), '[]'::jsonb)
    from public.flashcard fc where fc.learning_set_id = v_set.id;
  delete from public.flashcard where learning_set_id = p_learning_set_id;
  insert into public.flashcard (learning_set_id, key_text, "values", sort_order)
    select p_learning_set_id, public.trim_flashcard_text(item.card->>'key'), item.card->'values', item.ordinality::integer
    from jsonb_array_elements(p_cards) with ordinality as item(card, ordinality);
  update public.learning_set set title = public.trim_flashcard_text(p_title),
    source_mode = coalesce(p_source_mode, source_mode), updated_at = greatest(clock_timestamp(), v_set.updated_at + interval '1 microsecond')
    where id = p_learning_set_id returning * into v_set;
  return jsonb_build_object('id', v_set.id, 'title', v_set.title, 'original_request', v_set.original_request,
    'selected_topic', v_set.selected_topic, 'learning_goal', v_set.learning_goal, 'status', v_set.status,
    'created_at', v_set.created_at, 'updated_at', v_set.updated_at, 'source_mode', v_set.source_mode,
    'cards', (select jsonb_agg(jsonb_build_object('key', fc.key_text, 'values', fc."values") order by fc.sort_order)
      from public.flashcard fc where fc.learning_set_id = v_set.id));
end;
$$;

create or replace function public.delete_owned_learning_set(p_owner_id uuid, p_learning_set_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog
as $$
declare v_id uuid;
begin
  delete from public.learning_set where id = p_learning_set_id and owner_id = p_owner_id and status = 'COMPLETED' returning id into v_id;
  return v_id is not null;
end;
$$;

revoke all on function public.list_learning_sets(text, text, integer, integer, uuid, text) from public, anon, authenticated;
revoke all on function public.create_owned_learning_set(uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.update_owned_learning_set(uuid, uuid, timestamptz, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.delete_owned_learning_set(uuid, uuid) from public, anon, authenticated;
grant execute on function public.list_learning_sets(text, text, integer, integer, uuid, text) to service_role;
grant execute on function public.create_owned_learning_set(uuid, text, jsonb, text) to service_role;
grant execute on function public.update_owned_learning_set(uuid, uuid, timestamptz, text, jsonb, text) to service_role;
grant execute on function public.delete_owned_learning_set(uuid, uuid) to service_role;



-- Recovery is owner-scoped and uses the same row lock and optimistic version check as edits.
create or replace function public.restore_owned_learning_set_revision(
  p_owner_id uuid, p_learning_set_id uuid, p_revision_id uuid, p_expected_updated_at timestamptz
) returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare v_set public.learning_set; v_revision public.learning_set_revision;
begin
  select * into v_set from public.learning_set where id = p_learning_set_id
    and owner_id = p_owner_id and status = 'COMPLETED' for update;
  if not found then raise exception 'content not found or not owned' using errcode = 'P0002'; end if;
  if p_expected_updated_at is null or v_set.updated_at <> p_expected_updated_at then
    raise exception 'content changed since it was loaded' using errcode = '40001';
  end if;
  select * into v_revision from public.learning_set_revision where revision_id = p_revision_id
    and learning_set_id = p_learning_set_id and owner_id = p_owner_id;
  if not found then raise exception 'revision not found' using errcode = 'P0002'; end if;
  insert into public.learning_set_revision (learning_set_id, owner_id, title, source_mode, cards)
    select v_set.id, v_set.owner_id, v_set.title, v_set.source_mode,
      coalesce(jsonb_agg(jsonb_build_object('key', fc.key_text, 'values', fc."values") order by fc.sort_order), '[]'::jsonb)
    from public.flashcard fc where fc.learning_set_id = v_set.id;
  delete from public.flashcard where learning_set_id = p_learning_set_id;
  insert into public.flashcard (learning_set_id, key_text, "values", sort_order)
    select p_learning_set_id, item.card->>'key', item.card->'values', item.ordinality::integer
    from jsonb_array_elements(v_revision.cards) with ordinality as item(card, ordinality);
  update public.learning_set set title = v_revision.title, source_mode = v_revision.source_mode,
    updated_at = greatest(clock_timestamp(), v_set.updated_at + interval '1 microsecond')
    where id = p_learning_set_id returning * into v_set;
  return jsonb_build_object('id', v_set.id, 'title', v_set.title, 'original_request', v_set.original_request,
    'selected_topic', v_set.selected_topic, 'learning_goal', v_set.learning_goal, 'status', v_set.status,
    'created_at', v_set.created_at, 'updated_at', v_set.updated_at, 'source_mode', v_set.source_mode,
    'cards', (select jsonb_agg(jsonb_build_object('key', fc.key_text, 'values', fc."values") order by fc.sort_order)
      from public.flashcard fc where fc.learning_set_id = v_set.id));
end;
$$;
revoke all on function public.restore_owned_learning_set_revision(uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.restore_owned_learning_set_revision(uuid, uuid, uuid, timestamptz) to service_role;